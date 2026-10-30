const { randomInt } = require("node:crypto");

async function listenOnLoopback(server) {
  // Fetch blocks service ports through 10080; Windows can allocate them from a custom dynamic range.
  for (let attempt = 0; attempt < 32; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(attempt === 0 ? 0 : randomInt(49152, 65536), "127.0.0.1");
      });
    } catch (error) {
      if (error.code === "EADDRINUSE") continue;
      throw error;
    }
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    if (port > 10080) return port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error("Could not allocate a fetch-safe loopback port");
}

module.exports = { listenOnLoopback };
