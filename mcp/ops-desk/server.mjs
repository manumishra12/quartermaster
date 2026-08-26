#!/usr/bin/env node
/**
 * Ops Desk - a small operations surface for the incident responder to investigate.
 *
 * The incident responder was written against Sentry and could not be applied at all without a
 * Sentry account, so the one agent the hackathon calls its hero project was the one nobody could
 * run. This exists so that stops being true: it is the same shape of surface - alerts you can read,
 * deploys you can correlate them against, and remediations you cannot take without a person saying
 * yes - backed by a fixture rather than a company's production estate.
 *
 * It is deliberately not a mock in the testing sense. The read tools return the fixture; the write
 * tools genuinely mutate state and genuinely cannot be undone from inside this process, because an
 * approval gate in front of an operation that does nothing proves nothing.
 *
 * Every tool publishes annotations. That matters more here than anywhere else in the project: the
 * approval selectors `@read-only`, `@write` and `@destructive` are resolved from these hints, and
 * the catalog's own deepwiki server publishes none - which is the fail-open hole SECURITY.md
 * describes. This server is what a correctly annotated one looks like.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const FIXTURE = fileURLToPath(new URL('./incidents.json', import.meta.url));
/**
 * The port every instruction in this repo names. A default that disagrees with the documentation
 * sends anyone following it to a health check that fails and a connector registered at a dead URL.
 */
const PORT = Number(process.env.OPS_DESK_PORT ?? 8795);

/** Loaded once and then mutated in memory: a rollback has to actually change what the next read sees. */
const state = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const journal = [];

/** What a service is running now: the newest deploy for it. */
function currentDeploy(service) {
  return state.deploys
    .filter((d) => d.service === service)
    .sort((a, b) => b.shipped_at.localeCompare(a.shipped_at))[0];
}

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/**
 * A fresh server and transport per request.
 *
 * Sharing one transport across requests returns 500 on the very first `initialize`: a stateless
 * transport has no session to attach a second exchange to, so the connection the harness opens
 * has nowhere to live. The state these tools read and mutate is module-level and outlives them,
 * which is what makes a rollback in one request visible to the next.
 */
function buildServer() {
  const server = new McpServer({ name: 'ops-desk', version: '1.0.0' });

  server.registerTool(
    'list_alerts',
    {
      title: 'List alerts',
      description: 'Every alert the desk knows about, firing or resolved.',
      inputSchema: { status: z.enum(['firing', 'resolved', 'all']).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ status = 'all' }) => {
      const alerts = state.alerts.filter((a) => status === 'all' || a.status === status);
      return text({ now: state.now, count: alerts.length, alerts });
    },
  );

  server.registerTool(
    'get_alert',
    {
      title: 'Read one alert',
      description: 'Full detail for a single alert, including when it started and a sample error.',
      inputSchema: { alert_id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ alert_id }) => {
      const alert = state.alerts.find((a) => a.id === alert_id);
      // An unknown id is a fact about the world, not a crash. It is also still JSON: a tool that
      // answers with an object on the happy path and prose on the sad one makes every caller parse
      // twice, and the one place that matters is an agent deciding what it just learned.
      return alert
        ? text(alert)
        : text({ error: 'not_found', message: `No alert with id ${alert_id}.`, known: state.alerts.map((a) => a.id) });
    },
  );

  server.registerTool(
    'list_deploys',
    {
      title: 'List recent deploys',
      description: 'Recent deploys, newest first, so an alert can be correlated with what shipped.',
      inputSchema: { service: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ service }) => {
      const deploys = state.deploys
        .filter((d) => !service || d.service === service)
        .sort((a, b) => b.shipped_at.localeCompare(a.shipped_at));
      return text({ now: state.now, count: deploys.length, deploys });
    },
  );

  server.registerTool(
    'get_service_health',
    {
      title: 'Read service health',
      description: 'Error rate and p99 latency over the recent window for one service.',
      inputSchema: { service: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ service }) => {
      const series = state.health[service];
      return series
        ? text({ service, series })
        : text({ error: 'not_found', message: `No health series for ${service}.`, known: Object.keys(state.health) });
    },
  );

  server.registerTool(
    'rollback_deploy',
    {
      title: 'Roll back a deploy',
      description:
        'Revert a service to the deploy that preceded the given one. This is not reversible from here.',
      inputSchema: { deploy_id: z.string(), reason: z.string() },
      // The hint that puts this behind the gate. Getting it wrong is the whole failure mode.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ deploy_id, reason }) => {
      const deploy = state.deploys.find((d) => d.id === deploy_id);
      if (!deploy) {
        return text({ error: 'not_found', message: `No deploy with id ${deploy_id}.`, known: state.deploys.map((d) => d.id) });
      }

      /**
       * Only what is running can be reverted.
       *
       * Rolling back an older deploy used to remove it and report that the service had returned to
       * whatever preceded *it*, while the deploy actually serving traffic carried on untouched.
       * That is a reassuring operator-facing record of something that did not happen - the precise
       * failure this project exists to refuse, sitting in the tool it demonstrates with.
       */
      const current = currentDeploy(deploy.service);
      if (current.id !== deploy_id) {
        return text({
          error: 'not_current',
          message: `${deploy_id} is not what ${deploy.service} is running; ${current.id} is. Rolling it back would change nothing and say otherwise.`,
          current: current.id,
        });
      }

      // Actually mutate. A gate in front of an operation that does nothing proves nothing.
      state.deploys = state.deploys.filter((d) => d.id !== deploy_id);
      const entry = { action: 'rollback_deploy', deploy_id, service: deploy.service, to: deploy.previous, reason, at: state.now };
      journal.push(entry);
      return text({ ok: true, ...entry, note: 'The deploy is gone from the timeline. This process cannot put it back.' });
    },
  );

  server.registerTool(
    'restart_service',
    {
      title: 'Restart a service',
      description: 'Restart every instance of a service. In-flight requests are dropped.',
      inputSchema: { service: z.string(), reason: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ service, reason }) => {
      /**
       * A typo is not a restart.
       *
       * Any name at all used to come back `ok: true` with "Instances cycled", and the empty health
       * series it created then read back as a real service to everything downstream. An operator
       * approving a restart of `checkout-ap` would have been told it worked.
       */
      if (!(service in state.health)) {
        return text({
          error: 'not_found',
          message: `This desk does not know a service called ${service}. Nothing was restarted.`,
          known: Object.keys(state.health),
        });
      }

      const entry = { action: 'restart_service', service, reason, at: state.now };
      journal.push(entry);
      // Health readings do not survive a restart, which is part of why it is not a free action.
      state.health[service] = [];
      return text({ ok: true, ...entry, note: 'Instances cycled. The health series for this service was reset.' });
    },
  );

  server.registerTool(
    'list_actions_taken',
    {
      title: 'What this desk has done',
      description: 'The remediations performed in this session, in order.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => text({ count: journal.length, actions: journal }),
  );

  return server;
}

const http = createServer((req, res) => {
  if (req.url?.startsWith('/mcp')) {
    void (async () => {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      // Closing on the way out matters: without it every request leaks a transport and the
      // listeners attached to it, and a long investigation is a lot of requests.
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        // A transport failure must not take the process down and leave the agent on a dead socket.
        console.error('ops-desk request failed:', error);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    })();
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tools: 7, actions: journal.length }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

http.listen(PORT, () => {
  console.log(`ops-desk listening on http://localhost:${PORT}/mcp`);
  console.log('  read-only: list_alerts, get_alert, list_deploys, get_service_health, list_actions_taken');
  console.log('  destructive (gated): rollback_deploy, restart_service');
});
