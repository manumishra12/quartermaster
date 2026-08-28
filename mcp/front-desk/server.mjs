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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serve } from "../lib/serve.mjs";
import { z } from "zod";

const FIXTURE = fileURLToPath(new URL("./workspace.json", import.meta.url));

/** The port every instruction in this repo names. A default that disagrees sends you to a dead URL. */
const PORT = Number(process.env.FRONT_DESK_PORT ?? 8796);

/**
 * Loopback, unless someone says otherwise in as many words.
 *
 * These tools are gated by the harness, not by this server. A request that arrives here
 * directly has not passed the gate and will not meet it, so who can reach this port is the
 * whole of the access control. Binding every interface - which is what listen(PORT) alone
 * does - hands that to everyone on the network.
 */
const HOST = process.env.FRONT_DESK_HOST ?? "127.0.0.1";

/** Loaded once and mutated in memory: filing an issue has to change what the next read sees. */
const state = JSON.parse(readFileSync(FIXTURE, "utf8"));
let counter = 1000;

const text = (value) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const notFound = (message, known) =>
  text({ error: "not_found", message, known });

/**
 * Whether a field was actually given.
 *
 * A string of spaces looks present to every truthiness check and is not a title, a body, a
 * priority or a resolution. Accepting one files an issue with a blank required field and reports
 * it as filed, which is the same false record as any other - just harder to see.
 */
const given = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * The desk's clock, which has to move.
 *
 * `state.now` was a constant, so everything filed, edited, closed and sent carried the same
 * timestamp and the outbox read as though it had all happened at once. The order in which a person
 * did things to somebody else's tracker is most of what the record is for.
 */
function tick() {
  state.now = new Date(Date.parse(state.now) + 60_000)
    .toISOString()
    .replace(".000Z", "Z");
  return state.now;
}

/**
 * A bound on anything stored, because nothing else bounded it. Generous enough that no honest
 * ticket meets it, small enough that the workspace cannot be filled by one call.
 */
const TITLE = z.string().max(300);
const BODY = z.string().max(20000);
const NAME = z.string().max(200);

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * Every registered name, collected as they register.
 *
 * The startup banner and /health both used to carry a hand-written list and a hand-written
 * count. Both drift, and a server that misreports its own surface is a poor place to stand an
 * argument about honest reporting on.
 */
const registered = new Set();

const register = (server, name, meta, handler) => {
  registered.add(name);
  return server.registerTool(name, meta, handler);
};

function buildServer() {
  const server = new McpServer({ name: "front-desk", version: "1.0.0" });

  register(
    server,
    "list_projects",
    {
      title: "List projects",
      description:
        "Projects on this desk, with the conventions each team already follows.",
      annotations: READ_ONLY,
    },
    async () => text({ now: state.now, projects: state.projects }),
  );

  register(
    server,
    "list_teammates",
    {
      title: "List teammates",
      description:
        "Who can be assigned work or sent a message, and what they cover.",
      annotations: READ_ONLY,
    },
    async () => text({ teammates: state.teammates }),
  );

  register(
    server,
    "list_issues",
    {
      title: "List issues",
      description:
        "Existing issues, so a draft can match the format the team already uses.",
      inputSchema: {
        project: NAME.optional(),
        state: z.enum(["open", "closed", "all"]).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ project, state: wanted = "all" }) => {
      const issues = state.issues.filter(
        (i) =>
          (!project || i.project === project) &&
          (wanted === "all" || i.state === wanted),
      );
      return text({ count: issues.length, issues });
    },
  );

  register(
    server,
    "get_issue",
    {
      title: "Read one issue",
      description: "Full detail for a single issue, including its body.",
      inputSchema: { issue_id: NAME },
      annotations: READ_ONLY,
    },
    async ({ issue_id }) => {
      const issue = state.issues.find((i) => i.id === issue_id);
      return issue
        ? text(issue)
        : notFound(
            `No issue with id ${issue_id}.`,
            state.issues.map((i) => i.id),
          );
    },
  );

  register(
    server,
    "list_outbox",
    {
      title: "What this desk has actually done",
      description:
        "Issues filed, changed or closed and messages sent in this session, in order.",
      annotations: READ_ONLY,
    },
    async () => text({ count: state.outbox.length, actions: state.outbox }),
  );

  register(
    server,
    "search_workspace",
    {
      title: "Search everything this desk knows",
      description:
        "Search documents, issues and message history at once. The way to find the convention, the prior ticket, or the policy before drafting anything.",
      inputSchema: {
        query: NAME,
        kind: z.enum(["all", "documents", "issues", "messages"]).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ query, kind = "all" }) => {
      if (!given(query)) {
        return text({
          error: "missing_query",
          message:
            "A search needs something to search for. Whitespace matches everything and means nothing.",
        });
      }

      /**
       * Substring matching, and the limit is stated rather than hidden.
       *
       * This is a fixture, not a search engine: there is no stemming, no ranking by relevance and
       * no synonyms, so "retries" does not find "retry". An agent that gets nothing back and
       * concludes the workspace is empty has drawn the wrong conclusion from a weak index, which is
       * why every reply says how many records were searched.
       */
      const needle = query.trim().toLowerCase();
      const hit = (haystack) =>
        String(haystack ?? "")
          .toLowerCase()
          .includes(needle);

      const documents =
        kind === "all" || kind === "documents"
          ? state.documents.filter(
              (d) => hit(d.title) || hit(d.body) || hit(d.kind),
            )
          : [];
      const issues =
        kind === "all" || kind === "issues"
          ? state.issues.filter((i) => hit(i.title) || hit(i.body) || hit(i.id))
          : [];
      const messages =
        kind === "all" || kind === "messages"
          ? state.messages.filter(
              (m) => hit(m.body) || hit(m.from) || hit(m.channel),
            )
          : [];

      const searched =
        (kind === "all" || kind === "documents" ? state.documents.length : 0) +
        (kind === "all" || kind === "issues" ? state.issues.length : 0) +
        (kind === "all" || kind === "messages" ? state.messages.length : 0);

      return text({
        query: query.trim(),
        kind,
        matched: documents.length + issues.length + messages.length,
        /**
         * How many records were looked at, beside how many matched. Nothing found across forty
         * records is a fact about the workspace; nothing found across zero is a fact about the
         * filter, and they read identically without this number.
         */
        searched,
        note: "Substring match only - no stemming and no synonyms. Try a shorter or different word before concluding nothing is there.",
        documents,
        issues,
        messages,
      });
    },
  );

  register(
    server,
    "list_channels",
    {
      title: "List channels",
      description:
        "The channels on this desk, who is in them, and what each is for - including which of them pages somebody.",
      annotations: READ_ONLY,
    },
    async () =>
      text({ count: state.channels.length, channels: state.channels }),
  );

  register(
    server,
    "post_to_channel",
    {
      title: "Post to a channel",
      description:
        "Post a message to a channel. Everybody in it sees it, and one of them pages the on-call.",
      inputSchema: { channel: NAME, body: BODY },
      /**
       * Destructive, and for a reason a DM is not: a channel post is read by everybody in the
       * channel, and #incidents wakes somebody up. There is no unsend, and there is no undoing a
       * page at three in the morning.
       */
      annotations: DESTRUCTIVE,
    },
    async ({ channel, body }) => {
      const found = state.channels.find(
        (c) => c.name === channel.replace(/^#/, ""),
      );
      if (!found) {
        return notFound(
          `No channel called ${channel}. Nothing was posted.`,
          state.channels.map((c) => c.name),
        );
      }

      if (!given(body)) {
        return text({
          error: "missing_fields",
          message:
            "A post needs a body. Whitespace is not one, and nothing was posted.",
        });
      }

      const posted = {
        action: "post_to_channel",
        channel: found.name,
        body: body.trim(),
        at: tick(),
        /**
         * Said in the reply, because the approver is the person who has to know. A tool that
         * quietly pages an on-call engineer and reports "posted" has told them the least
         * interesting true thing about what just happened.
         */
        ...(found.name === "incidents"
          ? {
              paged: found.members,
              note: "Posted, and this channel pages everyone in it. It cannot be unsent.",
            }
          : { seen_by: found.members, note: "Posted. It cannot be unsent." }),
      };
      state.messages.push({
        channel: found.name,
        from: "assistant",
        at: posted.at,
        body: posted.body,
      });
      state.outbox.push(posted);
      return text({ ok: true, ...posted });
    },
  );

  register(
    server,
    "create_issue",
    {
      title: "File an issue",
      description: "File a new issue on a project. Other people will see it.",
      inputSchema: {
        project: NAME,
        title: TITLE,
        body: BODY,
        assignee: NAME,
        priority: NAME.optional(),
      },
      annotations: WRITES,
    },
    async ({ project, title, body, assignee, priority }) => {
      const found = state.projects.find((p) => p.key === project);
      if (!found)
        return notFound(
          `No project called ${project}.`,
          state.projects.map((p) => p.key),
        );

      const person = state.teammates.find((t) => t.handle === assignee);
      if (!person)
        return notFound(
          `No teammate called ${assignee}.`,
          state.teammates.map((t) => t.handle),
        );

      /**
       * A required field left blank is not a filed issue.
       *
       * The instructions say to ask when a required field is genuinely ambiguous rather than infer
       * it or leave it blank hoping nobody notices. This is what makes that more than advice.
       */
      const supplied = { title, body, assignee, priority };
      const missing = found.required_fields.filter(
        (field) => !given(supplied[field]),
      );
      if (missing.length > 0) {
        return text({
          error: "missing_fields",
          message: `${found.key} requires ${missing.join(", ")}. Nothing was filed.`,
          convention: found.convention,
        });
      }

      counter += 1;
      const issue = {
        id: `${project}-${counter}`,
        project,
        title,
        body,
        assignee,
        priority: priority ?? null,
        state: "open",
      };
      state.issues.push(issue);
      state.outbox.push({
        action: "create_issue",
        id: issue.id,
        project,
        title,
        assignee,
        at: tick(),
      });
      return text({
        ok: true,
        ...issue,
        note: "Filed. Other people can see this now.",
      });
    },
  );

  register(
    server,
    "update_issue",
    {
      title: "Edit an issue",
      description:
        "Change the title, body, assignee or priority of an existing issue.",
      inputSchema: {
        issue_id: NAME,
        title: TITLE.optional(),
        body: BODY.optional(),
        assignee: NAME.optional(),
        priority: NAME.optional(),
      },
      annotations: WRITES,
    },
    async ({ issue_id, ...changes }) => {
      const issue = state.issues.find((i) => i.id === issue_id);
      if (!issue)
        return notFound(
          `No issue with id ${issue_id}.`,
          state.issues.map((i) => i.id),
        );

      const offered = Object.entries(changes).filter(
        ([, value]) => value !== undefined,
      );

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
      const required =
        state.projects.find((p) => p.key === issue.project)?.required_fields ??
        [];
      const erasingRequired = offered
        .filter(([field, value]) => !given(value) && required.includes(field))
        .map(([field]) => field);
      if (erasingRequired.length > 0) {
        return text({
          error: "missing_fields",
          message: `${issue.project} requires ${erasingRequired.join(", ")}, so it cannot be set to nothing on ${issue_id}. Nothing was changed.`,
        });
      }

      // An optional field cleared is stored as absent rather than as an empty string.
      const cleared = offered.map(([field, value]) => [
        field,
        given(value) ? value : null,
      ]);

      /**
       * And a value identical to the one already there is not a change. Recording it as one is
       * exactly the false event this handler claims to prevent: an edit in the record that nobody
       * would find any trace of in the issue.
       */
      const applied = cleared.filter(
        ([field, value]) => issue[field] !== value,
      );
      if (applied.length === 0) {
        return text({
          error: "no_changes",
          message:
            offered.length === 0
              ? `Nothing was given to change on ${issue_id}.`
              : `${issue_id} already reads that way. Nothing was changed.`,
        });
      }

      if (
        changes.assignee &&
        !state.teammates.some((t) => t.handle === changes.assignee)
      ) {
        return notFound(
          `No teammate called ${changes.assignee}.`,
          state.teammates.map((t) => t.handle),
        );
      }

      for (const [field, value] of applied) issue[field] = value;
      state.outbox.push({
        action: "update_issue",
        id: issue_id,
        changed: applied.map(([f]) => f),
        at: tick(),
      });
      return text({
        ok: true,
        ...issue,
        note: `Changed ${applied.map(([f]) => f).join(", ")}.`,
      });
    },
  );

  register(
    server,
    "close_issue",
    {
      title: "Close an issue",
      description:
        "Close an issue. The team sees it disappear from their open list.",
      // Constrained in the schema so the refusal happens before the destructive branch is reached.
      inputSchema: {
        issue_id: NAME.min(1),
        resolution: BODY.trim().min(1),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ issue_id, resolution }) => {
      const issue = state.issues.find((i) => i.id === issue_id);
      if (!issue)
        return notFound(
          `No issue with id ${issue_id}.`,
          state.issues.map((i) => i.id),
        );

      /**
       * Closing what is already closed changes nothing, and saying it did is a false record of a
       * state change - on the far side of an approval somebody just gave.
       */
      if (!given(resolution)) {
        return text({
          error: "missing_fields",
          message: `Closing ${issue_id} needs a resolution. Nothing was closed.`,
        });
      }

      if (issue.state === "closed") {
        return text({
          error: "already_closed",
          message: `${issue_id} is already closed. Closing it again would change nothing and say otherwise.`,
        });
      }

      /**
       * The resolution is recorded beside the issue, not spliced into its body.
       *
       * Rewriting the body was an edit nobody approved. The card a person said yes to showed an
       * issue id and a resolution; what happened was that plus a silent modification of text
       * somebody else wrote. This server's own README makes the argument against exactly this: an
       * approver said yes to the description they were shown, so a tool that does more than the
       * description has laundered an unapproved change through a human decision. It is a worse
       * failure than an ungated write, because the record now carries a person's assent to it.
       */
      issue.state = "closed";
      issue.resolution = resolution;
      issue.closed_at = tick();
      state.outbox.push({
        action: "close_issue",
        id: issue_id,
        resolution,
        // The same instant the issue records, not a second one: this is one action.
        at: issue.closed_at,
      });
      return text({
        ok: true,
        id: issue_id,
        state: "closed",
        resolution,
        note: "Closed, with the resolution recorded beside the issue. The body was not touched, and this desk cannot reopen it.",
      });
    },
  );

  register(
    server,
    "send_email",
    {
      title: "Send an email",
      description:
        "Send an email on the operator's behalf. It leaves the building and cannot be unsent.",
      inputSchema: {
        to: NAME,
        subject: TITLE,
        body: BODY,
        cc: NAME.optional(),
      },
      /**
       * Destructive, and the most destructive thing on this desk.
       *
       * An issue filed wrongly is embarrassing inside the team. An email sent wrongly has left,
       * and the recipient may be outside the company entirely - so this is the tool where the gap
       * between "what the approver was shown" and "what actually goes" matters most, and the reply
       * therefore states the whole of what was sent rather than acknowledging it.
       */
      annotations: DESTRUCTIVE,
    },
    async ({ to, subject, body, cc }) => {
      const known = state.teammates.map((t) => t.handle);
      const person = state.teammates.find((t) => t.handle === to);

      /**
       * An address this desk does not know is refused rather than sent.
       *
       * This is the one refusal on this server that is not about honesty but about blast radius.
       * A ticket filed against the wrong project is visible and fixable; an email to an address
       * nobody recognised is gone, and the agent had no way to know whether it went to a customer,
       * a journalist or a typo. If a real recipient is missing, a person adds them.
       */
      if (!person) {
        return notFound(
          `No recipient called ${to}. Nothing was sent - an unrecognised address is the one mistake ` +
            "here that cannot be walked back.",
          known,
        );
      }

      if (cc !== undefined && !state.teammates.some((t) => t.handle === cc)) {
        return notFound(
          `No recipient called ${cc} to copy. Nothing was sent.`,
          known,
        );
      }

      const missing = [];
      if (!given(subject)) missing.push("subject");
      if (!given(body)) missing.push("body");
      if (missing.length) {
        return text({
          error: "missing_fields",
          message: `An email needs ${missing.join(" and ")}. Whitespace is not a value, and nothing was sent.`,
          missing,
        });
      }

      const sent = {
        action: "send_email",
        to,
        ...(cc ? { cc } : {}),
        subject: subject.trim(),
        body: body.trim(),
        at: tick(),
      };
      state.outbox.push(sent);
      return text({
        ok: true,
        ...sent,
        /**
         * The whole message back, not an acknowledgement. Somebody approved a description; this is
         * the record of what that description turned into, and the two being comparable is the
         * only way anyone can tell whether the tool did what they said yes to.
         */
        note: "Sent, exactly as shown. It cannot be unsent.",
      });
    },
  );

  register(
    server,
    "send_message",
    {
      title: "Send a message",
      description: "Send a message to a teammate. It cannot be unsent.",
      inputSchema: { to: NAME, body: BODY },
      annotations: DESTRUCTIVE,
    },
    async ({ to, body }) => {
      const person = state.teammates.find((t) => t.handle === to);
      if (!person)
        return notFound(
          `No teammate called ${to}. Nothing was sent.`,
          state.teammates.map((t) => t.handle),
        );

      /**
       * The only write tool here that did not check this, and the one that cannot be recalled.
       * A body of spaces was pushed to the outbox and reported as sent - on the far side of an
       * approval somebody had just given for a message with nothing in it.
       */
      if (!given(body)) {
        return text({
          error: "missing_fields",
          message:
            "A message needs a body. Whitespace is not one, and nothing was sent.",
        });
      }

      state.outbox.push({ action: "send_message", to, body, at: tick() });
      return text({ ok: true, to, note: "Sent. It cannot be unsent." });
    },
  );

  return server;
}

serve({
  name: "front-desk",
  buildServer,
  port: PORT,
  host: HOST,
  // Read from the registry rather than restated, so the banner and /health cannot drift
  // from what is actually registered. Building one server populates it.
  tools: () => {
    if (registered.size === 0) buildServer();
    return [...registered];
  },
  describe: () => ({
    filed: state.issues.length,
  }),
});
