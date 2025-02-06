declare module 'wakeonlan' {
    export default function wol(mac: string, opts?: Options): Promise<void>;

    export interface Options {
      from?: string,
      port?: number,
      count?: number,
      address?: string,
      interval?: number,
    }
}