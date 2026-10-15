import crypto from 'node:crypto';
import { input, output, identifier, fingerprint, fail, READS, OPERATIONS } from './contracts.mjs';

/** Independent business jobs. No HTTP request, socket, URL or native frame is stored. */
export class TaskBoard {
  constructor({ store = { data: { jobs: [] }, save() {} }, now = Date.now, leaseMs = 30_000, ttlMs = 300_000, maxJobs = 10000, maxBytes = 32 * 1024 * 1024, pruneQueueReads = false } = {}) {
    this.store = store; this.now = now; this.leaseMs = leaseMs; this.ttlMs = ttlMs;
    this.maxJobs = maxJobs; this.maxBytes = maxBytes;
    this.pruneQueueReads = pruneQueueReads;
    this.jobs = new Map((store.data.jobs ?? []).map(job => [job.id, { ...job }]));
    this.payloads = new Map(); this.results = new Map();
    for (const job of this.jobs.values()) {
      if (job.state === 'pending') job.state = 'expired';
      else if (['leased', 'running'].includes(job.state)) job.state = 'unknown';
    }
    this.save();
  }
  save() {
    if (this.broken) fail('storage_unavailable', 503);
    this.store.data.jobs = [...this.jobs.values()];
    try { this.store.save(); } catch (error) { this.broken = true; throw error; }
  }
  sweep() {
    if (this.broken) fail('storage_unavailable', 503);
    let changed = false;
    for (const job of this.jobs.values()) {
      if (['leased', 'running'].includes(job.state) && job.leaseUntil <= this.now()) {
        job.state = READS.has(job.operation) && this.payloads.has(job.id) && job.expiresAt > this.now() && job.attempts < 2 ? 'pending' : READS.has(job.operation) ? 'expired' : 'unknown';
        changed = true;
      }
      if (job.expiresAt <= this.now()) {
        this.payloads.delete(job.id); this.results.delete(job.id);
        if (job.state === 'pending') { job.state = 'expired'; changed = true; }
        if (this.pruneQueueReads && job.operation === 'queue.status' && ['succeeded','rejected','expired'].includes(job.state)) {
          this.jobs.delete(job.id); if(this.store.data.scopes) delete this.store.data.scopes[job.id]; changed=true;
        }
      }
    }
    if (changed) this.save();
  }
  submit(deviceId, operation, value, intentId) {
    this.sweep();
    identifier(deviceId); identifier(intentId);
    const validated = input(operation, value);
    const digest = fingerprint([deviceId, operation, validated]);
    const previous = [...this.jobs.values()].find(job => job.intentId === intentId);
    if (previous) { if (previous.fingerprint !== digest) fail('intent_conflict', 409); return this.get(previous.id); }
    if (this.jobs.size >= this.maxJobs) fail('job_capacity', 507);
    this.capacity(validated);
    const job = { id: crypto.randomUUID(), deviceId, operation, intentId, fingerprint: digest, state: 'pending', createdAt: this.now(), expiresAt: this.now() + this.ttlMs, attempts: 0 };
    this.jobs.set(job.id, job); this.payloads.set(job.id, validated);
    this.save();
    return this.get(job.id);
  }
  get(jobId) {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job) fail('job_not_found', 404);
    const { leaseHash: _, ...metadata } = job;
    return { ...metadata, resultAvailable: this.results.has(jobId), result: structuredClone(this.results.get(jobId) ?? null) };
  }
  capacity(value) {
    const bytes = [...this.payloads.values(), ...this.results.values(), value].reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    if (bytes > this.maxBytes) fail('payload_capacity', 507);
  }
  claim(deviceId, accepts = OPERATIONS) {
    this.sweep();
    const job = [...this.jobs.values()].find(job => job.deviceId === deviceId && job.state === 'pending' && accepts.includes(job.operation));
    if (!job) return null;
    job.state = 'leased'; const leaseToken = crypto.randomUUID(); job.leaseHash = fingerprint(leaseToken);
    job.attempts++; job.leaseUntil = this.now() + this.leaseMs;
    this.save();
    return { ...this.get(job.id), leaseToken, input: structuredClone(this.payloads.get(job.id)) };
  }
  owned(deviceId, jobId, token) {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job || job.deviceId !== deviceId) fail('job_not_found', 404);
    if (job.leaseHash !== fingerprint(token) || !['leased', 'running'].includes(job.state)) fail('invalid_lease', 409);
    return job;
  }
  ack(deviceId, jobId, token) { const job = this.owned(deviceId, jobId, token); job.state = 'running'; job.leaseUntil = this.now() + this.leaseMs; this.save(); }
  complete(deviceId, jobId, token, value) {
    const previous = this.jobs.get(jobId);
    if (previous?.deviceId === deviceId && previous.state === 'succeeded' && previous.leaseHash === fingerprint(token) && previous.resultHash === fingerprint(value)) return this.get(jobId);
    const job = this.owned(deviceId, jobId, token);
    if (job.state !== 'running') fail('job_not_acknowledged', 409);
    const validated = output(job.operation, value);
    this.capacity(validated);
    job.state = 'succeeded'; job.resultHash = fingerprint(validated); job.expiresAt = this.now() + this.ttlMs;
    this.results.set(jobId, validated); this.payloads.delete(jobId); this.save();
    return this.get(jobId);
  }
  reject(deviceId, jobId, token, state, code) {
    if (!['rejected', 'unknown'].includes(state) || !['precondition_rejected', 'native_unavailable', 'execution_unknown', 'capacity_reached'].includes(code)) fail('invalid_rejection');
    const previous = this.jobs.get(jobId);
    if (previous?.deviceId === deviceId && previous.state === state && previous.leaseHash === fingerprint(token) && previous.code === code) return this.get(jobId);
    const job = this.owned(deviceId, jobId, token); job.state = state; job.code = code; this.payloads.delete(jobId); this.save();
    return this.get(jobId);
  }
  reconcile(deviceId, jobId, intentFingerprint, value, state = 'succeeded', code = 'precondition_rejected') {
    if (!['succeeded', 'rejected'].includes(state) || state === 'rejected' && code !== 'precondition_rejected') fail('invalid_reconciliation');
    this.sweep(); const job = this.jobs.get(jobId);
    if (!job || job.deviceId !== deviceId) fail('job_not_found', 404);
    if (job.fingerprint !== intentFingerprint || !(job.state === 'unknown' || job.state === 'succeeded' && !this.results.has(jobId))) fail('reconciliation_rejected', 409);
    if (state === 'rejected' && code === 'precondition_rejected') { job.state = state; job.code = code; }
    else {
      const validated = output(job.operation, value); this.capacity(validated);
      if (job.resultHash && job.resultHash !== fingerprint(validated)) fail('receipt_conflict', 409);
      job.state = 'succeeded'; job.resultHash = fingerprint(validated); this.results.set(jobId, validated);
    }
    job.expiresAt = this.now() + this.ttlMs; this.save(); return this.get(jobId);
  }
}
