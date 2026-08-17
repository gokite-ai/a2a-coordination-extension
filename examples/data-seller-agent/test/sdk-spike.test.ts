/**
 * PLAN phase 0.1: the @a2a-js/sdk capability spike, kept as a regression test.
 *
 * The examples' claim is "an official A2A SDK plus this bundle suffices", so
 * before any protocol code exists this test pins the four capabilities the
 * spec needs from the SDK, over a real in-process HTTP round trip:
 *
 *   1. `raw` Parts carrying a media type (§6.1's transport for every
 *      Extension interaction and for the demo-private negotiation);
 *   2. the `A2A-Extensions` header, client → server (visible to the
 *      executor as `requestedExtensions`) and server → client (the
 *      response header echoes what the server activated);
 *   3. the Message-level `extensions` array, both directions;
 *   4. the JSON-RPC binding (`jsonRpcHandler` + `JsonRpcTransportFactory`).
 *
 * Verdict recorded in DESIGN §10: @a2a-js/sdk 1.0.1 covers the full surface —
 * no adapter needed.
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { Role, type AgentCard, type Message, type Part } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { Client, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions } from "@a2a-js/sdk/client";

const EXTENSION_URI = "https://a2a.gokite.ai/extensions/coordination-workflow/v1";
const NEGOTIATION_MEDIA_TYPE = "application/vnd.gokite.example-data-negotiation+json;version=1";
const COMMAND_MEDIA_TYPE = "application/vnd.gokite.agreement-command+json;version=1";

function agentCard(url: string): AgentCard {
  return {
    name: "spike seller",
    description: "SDK capability spike",
    version: "0.0.1",
    provider: undefined,
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: EXTENSION_URI,
          description: "spike",
          required: false,
          params: { commandMediaType: COMMAND_MEDIA_TYPE },
        },
      ],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: [NEGOTIATION_MEDIA_TYPE],
    defaultOutputModes: [NEGOTIATION_MEDIA_TYPE],
    skills: [],
    signatures: [],
  };
}

function rawPart(payload: unknown): Part {
  return {
    content: { $case: "raw", value: Buffer.from(JSON.stringify(payload), "utf8") },
    metadata: undefined,
    filename: "",
    mediaType: NEGOTIATION_MEDIA_TYPE,
  };
}

/** What the executor saw of the request, echoed back through the reply payload. */
interface EchoReport {
  requestedExtensions: string[];
  messageExtensions: string[];
  partMediaType: string;
  payload: unknown;
}

class EchoExecutor implements AgentExecutor {
  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const message = context.userMessage;
    const part = message.parts.find(
      (p) => p.content?.$case === "raw" && p.mediaType === NEGOTIATION_MEDIA_TYPE,
    );
    const report: EchoReport = {
      requestedExtensions: [...(context.context.requestedExtensions ?? [])],
      messageExtensions: [...message.extensions],
      partMediaType: part?.mediaType ?? "",
      payload:
        part && part.content?.$case === "raw"
          ? JSON.parse(Buffer.from(part.content.value).toString("utf8"))
          : null,
    };
    // Activate the extension for this call so the RESPONSE A2A-Extensions
    // header carries it back — the §2.2 handshake, server half.
    context.context.addActivatedExtension(EXTENSION_URI);
    const reply: Message = {
      messageId: "echo-1",
      contextId: context.contextId,
      taskId: "",
      role: Role.ROLE_AGENT,
      parts: [rawPart(report)],
      metadata: undefined,
      extensions: [EXTENSION_URI],
      referenceTaskIds: [],
    };
    eventBus.publish(AgentEvent.message(reply));
    eventBus.finished();
  }

  async cancelTask(): Promise<void> {}
}

describe("@a2a-js/sdk capability spike", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    const card = agentCard("http://127.0.0.1:0/a2a/v1");
    app.use(
      "/a2a/v1",
      jsonRpcHandler({
        requestHandler: new DefaultRequestHandler(card, new InMemoryTaskStore(), new EchoExecutor()),
        userBuilder: UserBuilder.noAuthentication,
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    url = `http://127.0.0.1:${address.port}/a2a/v1`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("raw parts, both extension channels, and JSON-RPC round-trip intact", async () => {
    const card = agentCard(url);
    const transport = await new JsonRpcTransportFactory().create(url, card);
    const client = new Client(transport, card);

    const result = await client.sendMessage(
      {
        tenant: "",
        message: {
          messageId: "spike-1",
          contextId: "",
          taskId: "",
          role: Role.ROLE_USER,
          parts: [rawPart({ kind: "query", states: ["CA"] })],
          metadata: undefined,
          extensions: [EXTENSION_URI], // §2.2 opt-in, message half
          referenceTaskIds: [],
        },
        configuration: undefined,
        metadata: undefined,
      },
      { serviceParameters: ServiceParameters.create(withA2AExtensions(EXTENSION_URI)) }, // §2.2 opt-in, header half
    );

    // SendMessageResult = Message | Task; a Message has no `status`.
    expect("parts" in result).toBe(true);
    if (!("parts" in result)) return;
    const reply = result as Message;

    // Channel 3, server → client: the reply message declares the extension.
    expect(reply.extensions).toContain(EXTENSION_URI);

    // Channel 1: the reply part is raw with the demo media type.
    const part = reply.parts[0]!;
    expect(part.content?.$case).toBe("raw");
    expect(part.mediaType).toBe(NEGOTIATION_MEDIA_TYPE);
    if (part.content?.$case !== "raw") return;
    const report = JSON.parse(Buffer.from(part.content.value).toString("utf8")) as EchoReport;

    // Channel 2, client → server: the header reached the executor.
    expect(report.requestedExtensions).toContain(EXTENSION_URI);
    // Channel 3, client → server: the message-level array reached it too.
    expect(report.messageExtensions).toContain(EXTENSION_URI);
    // Channel 1, client → server: raw bytes and media type survived intact.
    expect(report.partMediaType).toBe(NEGOTIATION_MEDIA_TYPE);
    expect(report.payload).toEqual({ kind: "query", states: ["CA"] });
  });
});
