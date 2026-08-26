import type WebSocket from "ws";

const SUPERSEDE_DRAIN_TIMEOUT_MS = 500;
const CORE_REVOKE_TIMEOUT_MS = 500;

export interface RealtimeSupersedeController {
  waitForCloseRequest(): Promise<void>;
  fail(): void;
}

export interface RealtimeConnectionLease {
  readonly active: boolean;
  setCoreRevoker(revoke: () => void | Promise<void>): boolean;
  setSupersedeController(controller: RealtimeSupersedeController): boolean;
}

interface MutableLease extends RealtimeConnectionLease {
  revoke(): Promise<void>;
  waitForSupersede(): Promise<void> | null;
  failSupersede(): boolean;
}

interface ConnectionOwner {
  cleanupScheduled: boolean;
  lease: MutableLease;
  socket: WebSocket;
}

export interface RealtimeConnectionActivation {
  socket: WebSocket;
  activate?: () => void | Promise<void>;
}

function createLease(): MutableLease {
  let active = true;
  let coreRevoker: (() => void | Promise<void>) | null = null;
  let supersedeController: RealtimeSupersedeController | null = null;
  let revocation: Promise<void> | null = null;

  return {
    get active(): boolean {
      return active;
    },
    setCoreRevoker(revoke: () => void | Promise<void>): boolean {
      if (!active || coreRevoker) return false;
      coreRevoker = revoke;
      return true;
    },
    setSupersedeController(
      controller: RealtimeSupersedeController,
    ): boolean {
      if (!active || supersedeController) return false;
      supersedeController = controller;
      return true;
    },
    revoke(): Promise<void> {
      if (revocation) return revocation;
      active = false;
      const revoke = coreRevoker;
      coreRevoker = null;
      revocation = Promise.resolve().then(() => revoke?.());
      return revocation;
    },
    waitForSupersede(): Promise<void> | null {
      return supersedeController?.waitForCloseRequest() ?? null;
    },
    failSupersede(): boolean {
      if (!supersedeController) return false;
      try {
        supersedeController.fail();
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function settleWithin(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const settled = operation.then(
    () => true,
    () => false,
  );
  const result = await Promise.race([settled, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

function closeInternalFailure(socket: WebSocket): void {
  try {
    socket.close(1011, "connection takeover failed");
  } catch {
    socket.terminate();
  }
}

function failSupersede(owner: ConnectionOwner): void {
  // Once a protocol transport owns the writer, it also owns the close
  // transition. Direct socket close is only the pre-controller fallback.
  if (!owner.lease.failSupersede()) closeInternalFailure(owner.socket);
}

/**
 * Serializes ownership replacement per Viva session. The activation callback is
 * invoked only after the old core has lost command authority and its connection
 * has entered the bounded supersede close path.
 */
export class RealtimeConnectionOwners {
  private readonly owners = new Map<string, ConnectionOwner>();
  private readonly tails = new Map<string, Promise<void>>();

  async replace(
    sessionId: string,
    open: (
      lease: RealtimeConnectionLease,
    ) => RealtimeConnectionActivation | Promise<RealtimeConnectionActivation>,
  ): Promise<void> {
    await this.serialized(sessionId, async () => {
      const existing = this.owners.get(sessionId);
      if (existing) {
        const revoked = await settleWithin(
          existing.lease.revoke(),
          CORE_REVOKE_TIMEOUT_MS,
        );
        if (!revoked) {
          failSupersede(existing);
          this.releaseWhenRevoked(sessionId, existing);
          throw new Error("Existing realtime core did not stop");
        }
        const supersede = existing.lease.waitForSupersede();
        const delivered =
          supersede !== null &&
          (await settleWithin(supersede, SUPERSEDE_DRAIN_TIMEOUT_MS));
        if (!delivered) {
          failSupersede(existing);
        }
        if (this.owners.get(sessionId) === existing) {
          this.owners.delete(sessionId);
        }
      }

      const lease = createLease();
      let activation: RealtimeConnectionActivation;
      try {
        activation = await open(lease);
      } catch (error) {
        await lease.revoke();
        throw error;
      }
      const { socket } = activation;

      if (socket.readyState !== socket.OPEN) {
        await lease.revoke();
        return;
      }

      const owner = { cleanupScheduled: false, lease, socket };
      this.owners.set(sessionId, owner);
      socket.once("close", () => {
        void this.release(sessionId, owner);
      });
      try {
        await activation.activate?.();
      } catch (error) {
        failSupersede(owner);
        const revoked = await settleWithin(
          lease.revoke(),
          CORE_REVOKE_TIMEOUT_MS,
        );
        if (revoked) {
          if (this.owners.get(sessionId) === owner) {
            this.owners.delete(sessionId);
          }
        } else {
          this.releaseWhenRevoked(sessionId, owner);
        }
        throw error;
      }
    });
  }

  private async release(sessionId: string, owner: ConnectionOwner): Promise<void> {
    await this.serialized(sessionId, async () => {
      if (this.owners.get(sessionId) !== owner) return;
      const revoked = await settleWithin(
        owner.lease.revoke(),
        CORE_REVOKE_TIMEOUT_MS,
      );
      if (revoked) {
        this.owners.delete(sessionId);
      } else {
        this.releaseWhenRevoked(sessionId, owner);
      }
    });
  }

  private releaseWhenRevoked(sessionId: string, owner: ConnectionOwner): void {
    if (owner.cleanupScheduled) return;
    owner.cleanupScheduled = true;
    // Keep the tombstone until the same revocation promise confirms that the
    // old core stopped. Deleting it on timeout would let a later owner overlap.
    void owner.lease.revoke().then(
      () =>
        this.serialized(sessionId, async () => {
          if (this.owners.get(sessionId) === owner) {
            this.owners.delete(sessionId);
          }
        }),
      () => undefined,
    );
  }

  private async serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    this.tails.set(sessionId, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }
}
