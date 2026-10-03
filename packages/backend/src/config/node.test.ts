import { describe, expect, it } from "vitest";
import { listExecutableNodeIds, parseNodeConfig, nodeOwnerError, type NodeConfig } from "./node.js";

const SECRET_32 = "0".repeat(32);

function baseEnv(): NodeJS.ProcessEnv {
  return {
    GATEWAY_NODE_ID: "node-a",
    GATEWAY_CONTROL_NODE_ID: "node-a",
    GATEWAY_NODE_SECRET: SECRET_32,
    GATEWAY_NODE_PEERS: JSON.stringify({
      "node-b": "https://node-b.example.com",
    }),
  };
}

describe("parseNodeConfig", () => {
  describe("defaults (single-node compatibility)", () => {
    it("returns disabled local config when GATEWAY_NODE_ID absent", () => {
      expect(parseNodeConfig({})).toEqual({
        enabled: false,
        id: "local",
        controlId: "local",
        peers: {},
        secret: "",
      });
    });

    it("ignores unrelated env vars", () => {
      expect(
        parseNodeConfig({ MYSQL_HOST: "db", GATEWAY_OTHER: "1" }),
      ).toEqual<NodeConfig>({
        enabled: false,
        id: "local",
        controlId: "local",
        peers: {},
        secret: "",
      });
    });

    it("treats empty-string GATEWAY_NODE_ID as absent", () => {
      expect(parseNodeConfig({ GATEWAY_NODE_ID: "" })).toEqual({
        enabled: false,
        id: "local",
        controlId: "local",
        peers: {},
        secret: "",
      });
    });
  });

  describe("partial config without ID fails", () => {
    it("fails when peers set but no ID", () => {
      expect(() =>
        parseNodeConfig({ GATEWAY_NODE_PEERS: '{"node-b":"https://b"}' }),
      ).toThrow(/GATEWAY_NODE_ID/);
    });

    it("fails when secret set but no ID", () => {
      expect(() =>
        parseNodeConfig({ GATEWAY_NODE_SECRET: SECRET_32 }),
      ).toThrow(/GATEWAY_NODE_ID/);
    });

    it("fails when control ID set but no ID", () => {
      expect(() =>
        parseNodeConfig({ GATEWAY_CONTROL_NODE_ID: "node-a" }),
      ).toThrow(/GATEWAY_NODE_ID/);
    });
  });

  describe("enabled validation", () => {
    it("parses a valid non-control node config", () => {
      const cfg = parseNodeConfig({
        GATEWAY_NODE_ID: "node-b",
        GATEWAY_CONTROL_NODE_ID: "node-a",
        GATEWAY_NODE_SECRET: SECRET_32,
        GATEWAY_NODE_PEERS: '{"node-a":"http://10.0.0.1:3000/"}',
      });
      expect(cfg).toEqual({
        enabled: true,
        id: "node-b",
        controlId: "node-a",
        peers: { "node-a": "http://10.0.0.1:3000" },
        secret: SECRET_32,
      });
    });

    it("parses a valid control node config with empty peers object", () => {
      const cfg = parseNodeConfig({
        GATEWAY_NODE_ID: "node-a",
        GATEWAY_CONTROL_NODE_ID: "node-a",
        GATEWAY_NODE_SECRET: SECRET_32,
        GATEWAY_NODE_PEERS: "{}",
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.controlId).toBe("node-a");
      expect(cfg.peers).toEqual({});
    });

    it("rejects invalid local ID", () => {
      for (const bad of ["Node-a", "1node", "node_a", "node a", "a".repeat(33), ""]) {
        expect(() => parseNodeConfig({ ...baseEnv(), GATEWAY_NODE_ID: bad }))
          .toThrow(/GATEWAY_NODE_ID/);
      }
    });

    it("requires explicit GATEWAY_CONTROL_NODE_ID", () => {
      const env = baseEnv();
      delete env.GATEWAY_CONTROL_NODE_ID;
      expect(() => parseNodeConfig(env)).toThrow(/GATEWAY_CONTROL_NODE_ID/);
    });

    it("rejects invalid control ID", () => {
      expect(() =>
        parseNodeConfig({ ...baseEnv(), GATEWAY_CONTROL_NODE_ID: "node-A" }),
      ).toThrow(/GATEWAY_CONTROL_NODE_ID/);
    });

    it("requires GATEWAY_NODE_SECRET >= 32 chars", () => {
      expect(() =>
        parseNodeConfig({ ...baseEnv(), GATEWAY_NODE_SECRET: "short" }),
      ).toThrow(/GATEWAY_NODE_SECRET/);
      expect(() =>
        parseNodeConfig({
          ...baseEnv(),
          GATEWAY_NODE_SECRET: "0".repeat(31),
        }),
      ).toThrow(/GATEWAY_NODE_SECRET/);
      const env = baseEnv();
      delete env.GATEWAY_NODE_SECRET;
      expect(() => parseNodeConfig(env)).toThrow(/GATEWAY_NODE_SECRET/);
    });

    it("requires GATEWAY_NODE_PEERS explicitly", () => {
      const env = baseEnv();
      delete env.GATEWAY_NODE_PEERS;
      expect(() => parseNodeConfig(env)).toThrow(/GATEWAY_NODE_PEERS/);
    });

    it("rejects non-JSON or non-object peers", () => {
      for (const bad of ["not-json", '["node-a"]', '"str"', "null", "42"]) {
        expect(() =>
          parseNodeConfig({ ...baseEnv(), GATEWAY_NODE_PEERS: bad }),
        ).toThrow(/GATEWAY_NODE_PEERS/);
      }
    });

    it("rejects invalid peer IDs", () => {
      expect(() =>
        parseNodeConfig({
          ...baseEnv(),
          GATEWAY_NODE_PEERS: '{"node-B":"https://b.example.com"}',
        }),
      ).toThrow(/peer ID/);
    });

    it("rejects peer identical to local ID", () => {
      expect(() =>
        parseNodeConfig({
          ...baseEnv(),
          GATEWAY_NODE_PEERS: '{"node-a":"https://b.example.com"}',
        }),
      ).toThrow(/本节点相同/);
    });

    it("rejects non-http(s) protocols", () => {
      expect(() =>
        parseNodeConfig({
          ...baseEnv(),
          GATEWAY_NODE_PEERS: '{"node-b":"ftp://b.example.com"}',
        }),
      ).toThrow(/http\(s\)/);
    });

    it("rejects userinfo, query, hash and path in peer URLs", () => {
      const badUrls = [
        "https://user:pass@b.example.com",
        "https://b.example.com?q=1",
        "https://b.example.com#frag",
        "https://b.example.com/gateway",
        "https://b.example.com/gateway/",
      ];
      for (const url of badUrls) {
        expect(() =>
          parseNodeConfig({
            ...baseEnv(),
            GATEWAY_NODE_PEERS: JSON.stringify({ "node-b": url }),
          }),
        ).toThrow(/peer 'node-b'/);
      }
    });

    it("accepts bare origin and trailing slash and normalizes them", () => {
      const cfg = parseNodeConfig({
        ...baseEnv(),
        GATEWAY_NODE_PEERS:
          '{"node-b":"https://b.example.com:8443/","node-c":"http://127.0.0.1:3000"}',
      });
      expect(cfg.peers).toEqual({
        "node-b": "https://b.example.com:8443",
        "node-c": "http://127.0.0.1:3000",
      });
    });

    it("rejects control ID that is neither local nor a configured peer", () => {
      expect(() =>
        parseNodeConfig({
          ...baseEnv(),
          GATEWAY_CONTROL_NODE_ID: "node-x",
        }),
      ).toThrow(/GATEWAY_CONTROL_NODE_ID/);
    });

    it("accepts control ID pointing at a configured peer", () => {
      const cfg = parseNodeConfig({
        GATEWAY_NODE_ID: "node-b",
        GATEWAY_CONTROL_NODE_ID: "node-a",
        GATEWAY_NODE_SECRET: SECRET_32,
        GATEWAY_NODE_PEERS: '{"node-a":"https://a.example.com"}',
      });
      expect(cfg.controlId).toBe("node-a");
    });
  });

  describe("nodeOwnerError", () => {
    const enabled: NodeConfig = {
      enabled: true,
      id: "node-a",
      controlId: "node-a",
      peers: { "node-b": "https://node-b.example.com" },
      secret: SECRET_32,
    };
    const disabled = parseNodeConfig({});

    it("accepts this node and any configured peer", () => {
      expect(nodeOwnerError("node-a", enabled)).toBeNull();
      expect(nodeOwnerError("node-b", enabled)).toBeNull();
      expect(listExecutableNodeIds(enabled)).toEqual(["node-a", "node-b"]);
    });

    it("names the usable nodes for an unknown owner", () => {
      expect(nodeOwnerError("mars", enabled)).toContain("mars");
      expect(nodeOwnerError("mars", enabled)).toContain("node-a, node-b");
    });

    it("rejects any explicit owner in single-node mode", () => {
      expect(listExecutableNodeIds(disabled)).toEqual([]);
      expect(nodeOwnerError("node-a", disabled)).toMatch(/多节点模式未启用/);
    });
  });
});
