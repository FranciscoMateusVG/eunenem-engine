/** Read-only provider observation. Missing evidence is never an estimated zero. */
export interface ProcessingFeeObservation {
  readonly provider: 'stripe' | 'inter';
  readonly accountRef: string;
  readonly environment: 'test' | 'live';
  readonly externalRef: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly source: string;
}
export interface ProcessingFeeReader {
  read(input: {
    chargeRef: string | null;
    paymentIntentRef: string | null;
  }): Promise<ProcessingFeeObservation | null>;
}
