export function computeBrowserArtifactRelease(input: {
  readonly client: Uint8Array;
  readonly styles: Uint8Array;
}): string;

export function writeBrowserArtifactRelease(appRoot?: string): Promise<string>;
