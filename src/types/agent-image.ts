export interface AgentImageRef {
  readonly version: 1;
  readonly sha256: string;
  readonly mediaType: 'image/png';
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly name: string;
}
export interface AgentImageUpload {
  readonly mediaType: string;
  readonly data: string;
  readonly name: string;
}
