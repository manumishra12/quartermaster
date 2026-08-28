import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostAllowed, routeOf } from './serve.mjs';

test('only this machine is answered, whatever the Host header claims', () => {
  for (const host of ['localhost', 'localhost:8795', '127.0.0.1', '127.0.0.1:8796', '[::1]', '[::1]:8795', 'LocalHost']) {
    assert.equal(hostAllowed(host), true, host);
  }

  /**
   * The rebinding cases. A page the attacker controls resolves its own name to 127.0.0.1 and posts
   * here; the browser sets Host to the name it was told to fetch, which is the one thing in the
   * request the page cannot choose. `localhost.evil.com` is the one that catches a naive
   * endsWith/startsWith check.
   */
  for (const host of ['evil.example.com', 'localhost.evil.com', 'evil.localhost', '192.168.0.120', '192.168.0.120:8795']) {
    assert.equal(hostAllowed(host), false, host);
  }

  // Absent, empty or non-string is refused rather than waved through. HTTP/1.1 requires a Host,
  // and the clients that omit one here are not the harness.
  for (const host of ['', '   ', undefined, null, 42, {}]) {
    assert.equal(hostAllowed(host), false, JSON.stringify(host));
  }
});

test('an operator can name the host they deliberately bound to', () => {
  assert.equal(hostAllowed('192.168.0.120:8795', ['192.168.0.120']), true);
  // and naming one does not admit the others
  assert.equal(hostAllowed('evil.example.com', ['192.168.0.120']), false);
});

test('a route is the path, not a prefix of it', () => {
  assert.equal(routeOf('/mcp'), '/mcp');
  assert.equal(routeOf('/mcp/'), '/mcp');
  assert.equal(routeOf('/mcp?session=1'), '/mcp');

  /**
   * The old test was `req.url.startsWith('/mcp')`, so these three were all handled as MCP. Verified
   * against the running server before the change: POST /mcp-anything answered 406, not 404.
   */
  assert.equal(routeOf('/mcp-anything'), '/mcp-anything');
  assert.equal(routeOf('/mcpevil'), '/mcpevil');
  assert.equal(routeOf('/mcp/../admin'), '/admin');

  assert.equal(routeOf('/health'), '/health');
  assert.equal(routeOf(undefined), '/');
});
