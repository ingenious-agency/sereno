import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { httpCommand } from "../src/actions.ts";
import { fixtureStore } from "../src/fixtures.ts";
import { run } from "../src/runner.ts";

test("curl sends one literal HEAD for bracket and brace paths without following redirects", async () => {
  const requests: { method: string | undefined; url: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(302, { Location: "/redirected" }); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    for (const path of ["/item[1-3]", "/item{one,two}"]) {
      requests.length = 0;
      const command = httpCommand({ ...fixtureStore().sites.data[0], url: `http://127.0.0.1:${address.port}${path}` });
      const result = await run(command);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, "302");
      // URL normalization percent-encodes braces, but they still name one literal path.
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "HEAD");
      assert.equal(decodeURI(requests[0].url!), path);
      assert.equal(command.args[0], "-q");
      assert.equal(command.args[command.args.indexOf("--proto") + 1], "=http,https");
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
