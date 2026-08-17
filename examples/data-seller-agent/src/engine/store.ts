/**
 * Where delivered bytes live, behind an interface.
 *
 * A self-hosted example needs only enough storage for the
 * Extension's evidence model — the artifact's content hash is its identity,
 * the locator is advisory, and the seller serves the bytes itself behind a
 * per-deal capability token (DESIGN §5).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface StoredArtifact {
  /** sha256 of the exact bytes, as `sha256:<hex>`. This is what delivery anchors. */
  contentHash: string;
  /** Byte length. Carried so a truncated download is detectable before hashing. */
  bytes: number;
  /** Where the bytes were put. Advisory — the hash is the identity. */
  locator: string;
}

export interface ArtifactStore {
  put(input: { bytes: Buffer; dealId: string; filename: string }): Promise<StoredArtifact>;
  get(contentHash: string): Promise<Buffer | undefined>;
}

export const sha256Bytes = (bytes: Buffer): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Content-addressed files under one directory. Enough for a demo; says so. */
export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly dir: string) {}

  async put(input: { bytes: Buffer; dealId: string; filename: string }): Promise<StoredArtifact> {
    const contentHash = sha256Bytes(input.bytes);
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, contentHash.replace("sha256:", ""));
    await writeFile(path, input.bytes);
    return { contentHash, bytes: input.bytes.length, locator: path };
  }

  async get(contentHash: string): Promise<Buffer | undefined> {
    try {
      return await readFile(join(this.dir, contentHash.replace("sha256:", "")));
    } catch {
      return undefined;
    }
  }
}

/** Process-local store for tests and the standalone demo. */
export class MemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, Buffer>();

  async put(input: { bytes: Buffer; dealId: string; filename: string }): Promise<StoredArtifact> {
    const contentHash = sha256Bytes(input.bytes);
    this.artifacts.set(contentHash, input.bytes);
    return { contentHash, bytes: input.bytes.length, locator: `memory:${input.dealId}/${input.filename}` };
  }

  async get(contentHash: string): Promise<Buffer | undefined> {
    return this.artifacts.get(contentHash);
  }
}
