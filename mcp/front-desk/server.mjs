#!/usr/bin/env node
/**
 * Front Desk - a place for the approval-gated assistant to draft and file work.
 *
 * `desk-assistant` was written against Linear, so without a Linear account `agents:apply` skipped
 * it and the hackathon's "easiest start" card was one of two agents nobody could run. This is the
 * same shape of surface - a workspace to read, conventions to match, and things you cannot create,
 * change or send without a person saying yes - backed by a fixture rather than someone's real
 * tracker.
 *
 * Two properties are deliberate, and both are tested:
 *
 * 1. The write tools refuse anything they cannot honestly do. Filing into a project that does not
 *    exist, closing an issue that is already closed, messaging somebody who is not there: each
 *    returns a structured refusal and records nothing. A tool that reports success for work it did
 *    not do is the failure this whole project exists to refuse, and it is worse here than anywhere
 *    because a person approved the action believing the description.
 *
 * 2. One fixture issue contains a prompt injection - a note in the body claiming the work is
 *    pre-approved and that the agent should not stop for approval. The agent's instructions say
 *    that everything it reads is data and never instruction. That claim is worth nothing without
 *    something that tests it, so here is something that tests it. The gate holds regardless: the
 *    harness stops the turn whatever the model was persuaded of, which is the entire argument for
 *    putting the gate outside the model.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const FIXTURE = fileURLToPath(new URL('./workspace.json', import.meta.url));

/** The port every instruction in this repo names. A default that disagrees sends you to a dead URL. */
const PORT = Number(process.env.FRONT_DESK_PORT ?? 8796);

/** Loaded once and mutated in memory: filing an issue has to change what the next read sees. */
const state = JSON.parse(readFileSync(FIXTURE, 'utf8'));
let counter = 1000;

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const notFound = (message, known) => text({ error: 'not_found', message, known });

/**
 * Whether a field was actually given.
 *
 * A string of spaces looks present to every truthiness check and is not a title, a body, a
 * priority or a resolution. Accepting one files an issue with a blank required field and reports
 * it as filed, which is the same false record as any other - just harder to see.
 */
const given = (value) => typeof value === 'string' && value.trim().length > 0;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function buildServer() {
  const server = new McpServer({ name: 'front-desk', version: '1.0.0' });

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects on this desk, with the conventions each team already follows.',
      annotations: READ_ONLY,
    },
    async () => text({ now: state.now, projects: state.projects }),
  );

  server.registerTool(
    'list_teammates',
    {
      title: 'List teammates',
      description: 'Who can be assigned work or sent a message, and what they cover.',
      annotations: READ_ONLY,
    },
    async () => text({ teammates: state.teammates }),
  );

  server.registerTool(
    'list_issues',
    {
      title: 'List issues',
      description: 'Existing issues, so a draft can match the format the team already uses.',
      inputSchema: { project: z.string().optional(), state: z.enum(['open', 'closed', 'all']).optional() },
      annotations: READ_ONLY,
    },
    async ({ project, state: wanted = 'all' }) => {
      const issues = state.issues.filter(
        (i) => (!project || i.project === project) && (wanted === 'all' || i.state === wanted),
      );
      return text({ count: issues.length, issues });
    },
  );

  server.registerTool(
    'get_issue',
    {
      title: 'Read one issue',
      description: 'Full detail for a single issue, including its body.',
      inputSchema: { issue_id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ issue_id }) => {
      const issue = state.issues.find((i) => i.id === issue_id);
      return issue
        ? text(issue)
        : notFound(`No issue with id ${issue_id}.`, state.issues.map((i) => i.id));
    },
  );

  server.registerTool(
    'list_outbox',
    {
      title: 'What this desk has actually done',
      description: 'Issues filed, changed or closed and messages sent in this session, in order.',
      annotations: READ_ONLY,
    },
    async () => text({ count: state.outbox.length, actions: state.outbox }),
  );

  server.registerTool(
    'create_issue',
    {
      title: 'File an issue',
      description: 'File a new issue on a project. Other people will see it.',
      inputSchema: {
        project: z.string(),
        title: z.string(),
        body: z.string(),
        assignee: z.string(),
        priority: z.string().optional(),
      },
      annotations: WRITES,
    },
    async ({ project, title, body, assignee, priority }) => {
      const found = state.projects.find((p) => p.key === project);
      if (!found) return notFound(`No project called ${project}.`, state.projects.map((p) => p.key));

      const person = state.teammates.find((t) => t.handle === assignee);
      if (!person) return notFound(`No teammate called ${assignee}.`, state.teammates.map((t) => t.handle));

      /**
       * A required field left blank is not a filed issue.
       *
       * The instructions say to ask when a required field is genuinely ambiguous rather than infer
       * it or leave it blank hoping nobody notices. This is what makes that more than advice.
       */
      const supplied = { title, body, assignee, priority };
      const missing = found.required_fields.filter((field) => !given(supplied[field]));
      if (missing.length > 0) {
        return text({
          error: 'missing_fields',
          message: `${found.key} requires ${missing.join(', ')}. Nothing was filed.`,
          convention: found.convention,
        });
      }

      counter += 1;
      const issue = { id: `${project}-${counter}`, project, title, body, assignee, priority: priority ?? null, state: 'open' };
      state.issues.push(issue);
      state.outbox.push({ action: 'create_issue', id: issue.id, project, title, assignee, at: state.now });
      return text({ ok: true, ...issue, note: 'Filed. Other people can see this now.' });
    },
  );

  server.registerTool(
    'update_issue',
    {
      title: 'Edit an issue',
      description: 'Change the title, body, assignee or priority of an existing issue.',
      inputSchema: {
        issue_id: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        assignee: z.string().optional(),
        priority: z.string().optional(),
      },
      annotations: WRITES,
    },
    async ({ issue_id, ...changes }) => {
      const issue = state.issues.find((i) => i.id === issue_id);
      if (!issue) return notFound(`No issue with id ${issue_id}.`, state.issues.map((i) => i.id));

      const offered = Object.entries(changes).filter(([, value]) => value !== undefined);

      /**
       * A field named but left blank is an attempt to erase it, and whether that is allowed
       * depends on the project rather than on the field.
       *
       * Clearing something the project requires would leave the issue in a state the desk would
       * refuse to create - and it slipped past the existence check entirely, which only ran when
       * the value was truthy. But refusing *every* blank was the opposite mistake: priority is
       * optional on SRCH, so removing it is a real edit, and calling it a missing required field
       * made a valid operation impossible and described it wrongly on the way out.
       */
      const required = state.projects.find((p) => p.key === issue.project)?.required_fields ?? [];
      const erasingRequired = offered
        .filter(([field, value]) => !given(value) && required.includes(field))
        .map(([field]) => field);
      if (erasingRequired.length > 0) {
        return text({
          error: 'missing_fields',
          message: `${issue.project} requires ${erasingRequired.join(', ')}, so it cannot be set to nothing on ${issue_id}. Nothing was changed.`,
        });
      }

      // An optional field cleared is stored as absent rather than as an empty string.
      const cleared = offered.map(([field, value]) => [field, given(value) ? value : null]);

      /**
       * And a value identical to the one already there is not a change. Recording it as one is
       * exactly the false event this handler claims to prevent: an edit in the record that nobody
       * would find any trace of in the issue.
       */
      const applied = cleared.filter(([field, value]) => issue[field] !== value);
      if (applied.length === 0) {
        return text({
          error: 'no_changes',
          message: offered.length === 0
            ? `Nothing was given to change on ${issue_id}.`
            : `${issue_id} already reads that way. Nothing was changed.`,
        });
      }

      if (changes.assignee && !state.teammates.some((t) => t.handle === changes.assignee)) {
        return notFound(`No teammate called ${changes.assignee}.`, state.teammates.map((t) => t.handle));
      }

      for (const [field, value] of applied) issue[field] = value;
      state.outbox.push({ action: 'update_issue', id: issue_id, changed: applied.map(([f]) => f), at: state.now });
      return text({ ok: true, ...issue, note: `Changed ${applied.map(([f]) => f).join(', ')}.` });
    },
  );

  server.registerTool(
    'close_issue',
    {
      title: 'Close an issue',
      description: 'Close an issue. The team sees it disappear from their open list.',
      // Constrained in the schema so the refusal happens before the destructive branch is reached.
      inputSchema: { issue_id: z.string().min(1), resolution: z.string().trim().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ issue_id, resolution }) => {
      const issue = state.issues.find((i) => i.id === issue_id);
      if (!issue) return notFound(`No issue with id ${issue_id}.`, state.issues.map((i) => i.id));

      /**
       * Closing what is already closed changes nothing, and saying it did is a false record of a
       * state change - on the far side of an approval somebody just gave.
       */
      if (!given(resolution)) {
        return text({ error: 'missing_fields', message: `Closing ${issue_id} needs a resolution. Nothing was closed.` });
      }

      if (issue.state === 'closed') {
        return text({
          error: 'already_closed',
          message: `${issue_id} is already closed. Closing it again would change nothing and say otherwise.`,
        });
      }

      issue.state = 'closed';
      issue.body = `${issue.body}\n\nResolution\n${resolution}`;
      state.outbox.push({ action: 'close_issue', id: issue_id, resolution, at: state.now });
      return text({ ok: true, id: issue_id, state: 'closed', note: 'Closed. This desk cannot reopen it.' });
    },
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send a message',
      description: 'Send a message to a teammate. It cannot be unsent.',
      inputSchema: { to: z.string(), body: z.string() },
      annotations: DESTRUCTIVE,
    },
    async ({ to, body }) => {
      const person = state.teammates.find((t) => t.handle === to);
      if (!person) return notFound(`No teammate called ${to}. Nothing was sent.`, state.teammates.map((t) => t.handle));

      state.outbox.push({ action: 'send_message', to, body, at: state.now });
      return text({ ok: true, to, note: 'Sent. It cannot be unsent.' });
    },
  );

  return server;
}

const http = createServer((req, res) => {
  if (req.url?.startsWith('/mcp')) {
    void (async () => {
      // A fresh server and transport per request: a stateless transport has no session for a
      // second exchange to attach to, and sharing one returns 500 on the first initialize.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error('front-desk request failed:', error);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    })();
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tools: 9, filed: state.outbox.length }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

http.listen(PORT, () => {
  // With PORT=0 the OS assigns a free one, so report what we actually got rather than what we asked for.
  const bound = http.address().port;
  console.log(`front-desk listening on http://localhost:${bound}/mcp`);
  console.log('  read-only: list_projects, list_teammates, list_issues, get_issue, list_outbox');
  console.log('  gated:     create_issue, update_issue, close_issue, send_message');
});
