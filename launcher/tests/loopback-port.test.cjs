const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const { listenOnLoopback } = require("../electron/loopback-port.cjs");

test("local browser channels skip OS ports blocked by fetch", async () => {
  class Server extends EventEmitter {
    ports = [4190, 6000, 10080, 12001];
    listen(_port, host) {
      assert.equal(host, "127.0.0.1");
      this.port = this.ports.shift();
      queueMicrotask(() => this.emit("listening"));
    }
    address() { return { port: this.port }; }
    close(done) { queueMicrotask(done); }
  }
  const server = new Server();
  assert.equal(await listenOnLoopback(server), 12001);
  assert.deepEqual(server.ports, []);
});

test("local port allocation is bounded and propagates listen failures", async () => {
  const server = new EventEmitter();
  server.listen = () => queueMicrotask(() => server.emit("error", new Error("listen failed")));
  await assert.rejects(listenOnLoopback(server), /listen failed/);
  server.listen = () => queueMicrotask(() => server.emit("listening"));
  server.address = () => ({ port: 4190 });
  server.close = done => queueMicrotask(done);
  await assert.rejects(listenOnLoopback(server), /fetch-safe loopback port/);
});

test("a busy replacement port is retried without keeping startup listeners", async () => {
  const server = new EventEmitter();
  const ports = [];
  server.listen = (port, host) => {
    assert.equal(host, "127.0.0.1");
    ports.push(port);
    queueMicrotask(() => ports.length === 1
      ? server.emit("error", Object.assign(new Error("busy"), { code: "EADDRINUSE" }))
      : server.emit("listening"));
  };
  server.address = () => ({ port: ports.at(-1) });
  const port = await listenOnLoopback(server);
  assert.equal(ports[0], 0);
  assert.ok(port >= 49152 && port <= 65535);
  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("listening"), 0);
});

test("an allocated local browser channel is reachable through Node fetch", async () => {
  const server = http.createServer((_req, res) => res.end("ready"));
  try {
    const port = await listenOnLoopback(server);
    assert.equal(await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5000) }).then(r => r.text()), "ready");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
