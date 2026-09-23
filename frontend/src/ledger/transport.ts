/**
 * Ledger APDU transport over WebHID. Framing follows Ledger's HID protocol
 * (@ledgerhq/devices hid-framing): 64-byte reports, each starting with a
 * 2-byte channel, tag 0x05 and a 2-byte sequence number; the first report of
 * a message also carries its 2-byte total length.
 */

export const LEDGER_VENDOR_ID = 0x2c97;
const PACKET_SIZE = 64;
const TAG = 0x05;
const SW_OK = 0x9000;

interface HidInputReportEvent extends Event {
  readonly device: HidDevice;
  readonly data: DataView;
}

interface HidDevice {
  readonly opened: boolean;
  readonly productName: string;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  addEventListener(type: "inputreport", listener: (event: HidInputReportEvent) => void): void;
  removeEventListener(type: "inputreport", listener: (event: HidInputReportEvent) => void): void;
}

interface HidConnectionEvent extends Event {
  readonly device: HidDevice;
}

interface WebHid {
  requestDevice(options: { filters: { vendorId: number }[] }): Promise<HidDevice[]>;
  addEventListener(type: "disconnect", listener: (event: HidConnectionEvent) => void): void;
  removeEventListener(type: "disconnect", listener: (event: HidConnectionEvent) => void): void;
}

function webHid(): WebHid | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { hid?: WebHid }).hid;
}

export function webHidSupported(): boolean {
  return webHid() !== undefined;
}

/** A status word other than 0x9000 from the device. */
export class LedgerStatusError extends Error {
  constructor(public readonly status: number) {
    super(`Ledger returned status 0x${status.toString(16).padStart(4, "0")}`);
    this.name = "LedgerStatusError";
  }
}

/** A failure with text that can be shown to the user as is. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export function frameApdu(channel: number, apdu: Uint8Array): Uint8Array[] {
  const data = new Uint8Array(apdu.length + 2);
  data[0] = apdu.length >> 8;
  data[1] = apdu.length & 0xff;
  data.set(apdu, 2);
  const blockSize = PACKET_SIZE - 5;
  const count = Math.max(1, Math.ceil(data.length / blockSize));
  const blocks: Uint8Array[] = [];
  for (let seq = 0; seq < count; seq++) {
    const block = new Uint8Array(PACKET_SIZE);
    block[0] = channel >> 8;
    block[1] = channel & 0xff;
    block[2] = TAG;
    block[3] = seq >> 8;
    block[4] = seq & 0xff;
    block.set(data.subarray(seq * blockSize, (seq + 1) * blockSize), 5);
    blocks.push(block);
  }
  return blocks;
}

/** Reassembles one response from consecutive 64-byte reports. */
export class ResponseAssembler {
  private data: Uint8Array | null = null;
  private filled = 0;
  private sequence = 0;

  constructor(private readonly channel: number) {}

  /** Returns the complete response (data + status word) once all reports arrived. */
  push(report: Uint8Array): Uint8Array | null {
    if (report.length < 5) throw new LedgerError("The Ledger sent a malformed reply.");
    const channel = (report[0] << 8) | report[1];
    const sequence = (report[3] << 8) | report[4];
    if (channel !== this.channel || report[2] !== TAG || sequence !== this.sequence) {
      throw new LedgerError("The Ledger sent an unexpected reply. Disconnect and connect it again.");
    }
    this.sequence++;
    let body = report.subarray(5);
    if (this.data === null) {
      this.data = new Uint8Array((body[0] << 8) | body[1]);
      body = body.subarray(2);
    }
    const take = Math.min(body.length, this.data.length - this.filled);
    this.data.set(body.subarray(0, take), this.filled);
    this.filled += take;
    return this.filled === this.data.length ? this.data : null;
  }
}

/** Sends one APDU and returns the response data, or throws on a non-OK status. */
export type Apdu = (cla: number, ins: number, p1: number, p2: number, data?: Uint8Array) => Promise<Uint8Array>;

export function splitStatus(response: Uint8Array): Uint8Array {
  if (response.length < 2) throw new LedgerError("The Ledger sent a malformed reply.");
  const status = (response[response.length - 2] << 8) | response[response.length - 1];
  if (status !== SW_OK) throw new LedgerStatusError(status);
  return response.subarray(0, response.length - 2);
}

export function encodeApdu(cla: number, ins: number, p1: number, p2: number, data: Uint8Array): Uint8Array {
  if (data.length > 255) throw new Error("APDU data is limited to 255 bytes");
  const apdu = new Uint8Array(5 + data.length);
  apdu.set([cla, ins, p1, p2, data.length]);
  apdu.set(data, 5);
  return apdu;
}

export class WebHidLedger {
  private readonly channel = Math.floor(Math.random() * 0xffff);
  private queue: Promise<unknown> = Promise.resolve();
  private reports: Uint8Array[] = [];
  private waiter: { resolve: (report: Uint8Array) => void; reject: (err: Error) => void } | null = null;
  private closed = false;

  private constructor(
    private readonly device: HidDevice,
    private readonly onDisconnect: () => void,
  ) {
    device.addEventListener("inputreport", this.onReport);
    webHid()?.addEventListener("disconnect", this.onHidDisconnect);
  }

  /** Opens the browser's device picker. Must run from a click handler. */
  static async request(onDisconnect: () => void): Promise<WebHidLedger> {
    const hid = webHid();
    if (!hid) throw new LedgerError("This browser cannot connect to a Ledger over USB. Use Chrome, Edge, or Brave on a computer.");
    let devices: HidDevice[];
    try {
      devices = await hid.requestDevice({ filters: [{ vendorId: LEDGER_VENDOR_ID }] });
    } catch {
      throw new LedgerError("The browser did not allow access to the Ledger.");
    }
    const device = devices[0];
    if (!device) throw new LedgerError("No Ledger was selected.");
    if (!device.opened) {
      try {
        await device.open();
      } catch {
        throw new LedgerError(
          "Could not open the Ledger. Close Ledger Wallet and any other app or tab using it, then try again.",
        );
      }
    }
    return new WebHidLedger(device, onDisconnect);
  }

  get name(): string {
    return this.device.productName || "Ledger";
  }

  readonly apdu: Apdu = (cla, ins, p1, p2, data = new Uint8Array(0)) => {
    const run = this.queue.then(() => this.exchange(encodeApdu(cla, ins, p1, p2, data)));
    this.queue = run.catch(() => undefined);
    return run.then(splitStatus);
  };

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.device.removeEventListener("inputreport", this.onReport);
    webHid()?.removeEventListener("disconnect", this.onHidDisconnect);
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(new LedgerError("The Ledger was disconnected. Connect it again."));
    await this.device.close().catch(() => undefined);
  }

  private async exchange(apdu: Uint8Array): Promise<Uint8Array> {
    if (this.closed) throw new LedgerError("The Ledger is not connected. Connect it again.");
    this.reports = [];
    for (const block of frameApdu(this.channel, apdu)) {
      try {
        await this.device.sendReport(0, block);
      } catch {
        throw new LedgerError("Could not send to the Ledger. Check the cable and that the device is unlocked.");
      }
    }
    const assembler = new ResponseAssembler(this.channel);
    for (;;) {
      const done = assembler.push(await this.nextReport());
      if (done) return done;
    }
  }

  private nextReport(): Promise<Uint8Array> {
    const queued = this.reports.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new LedgerError("The Ledger was disconnected. Connect it again."));
        return;
      }
      this.waiter = { resolve, reject };
    });
  }

  private onReport = (event: HidInputReportEvent) => {
    const report = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength).slice();
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve(report);
    } else {
      this.reports.push(report);
    }
  };

  private onHidDisconnect = (event: HidConnectionEvent) => {
    if (event.device !== this.device) return;
    void this.close();
    this.onDisconnect();
  };
}
