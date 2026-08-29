import { Buffer } from "node:buffer";

export class HeadTailBuffer {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #totalBytes = 0;

  public constructor(headLimit: number, tailLimit: number) {
    if (!Number.isSafeInteger(headLimit) || headLimit < 0) {
      throw new RangeError("headLimit must be a non-negative integer");
    }
    if (!Number.isSafeInteger(tailLimit) || tailLimit < 0) {
      throw new RangeError("tailLimit must be a non-negative integer");
    }
    this.#headLimit = headLimit;
    this.#tailLimit = tailLimit;
  }

  public write(chunk: Uint8Array | string): void {
    let incoming = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    this.#totalBytes += incoming.byteLength;

    const headRemaining = this.#headLimit - this.#head.byteLength;
    if (headRemaining > 0) {
      const retained = incoming.subarray(0, headRemaining);
      this.#head = Buffer.concat([this.#head, retained]);
      incoming = incoming.subarray(retained.byteLength);
    }

    if (this.#tailLimit === 0 || incoming.byteLength === 0) {
      return;
    }
    if (incoming.byteLength >= this.#tailLimit) {
      this.#tail = Buffer.from(incoming.subarray(incoming.byteLength - this.#tailLimit));
      return;
    }
    const combined = Buffer.concat([this.#tail, incoming]);
    this.#tail = Buffer.from(
      combined.subarray(Math.max(0, combined.byteLength - this.#tailLimit)),
    );
  }

  public get totalBytes(): number {
    return this.#totalBytes;
  }

  public get truncated(): boolean {
    return this.#totalBytes > this.#head.byteLength + this.#tail.byteLength;
  }

  public toString(): string {
    const head = this.#head.toString("utf8");
    if (!this.truncated) {
      return head + this.#tail.toString("utf8");
    }
    const omitted = this.#totalBytes - this.#head.byteLength - this.#tail.byteLength;
    return `${head}\n... [${omitted} bytes omitted] ...\n${this.#tail.toString("utf8")}`;
  }
}
