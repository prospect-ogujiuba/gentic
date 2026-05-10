# rpc

RPC/client integration surfaces.

## Discovery

Extensions live at `extensions/rpc/<name>/index.ts`. Put helper files beside that `index.ts`.

## Example Gentic extensions

- **RPC Workflow Bridge** — exposes Gentic workflow actions to an external client.
- **Client UI Relay** — forwards Gentic UI notifications over RPC.
- **Remote Session Control** — coordinates session actions from an RPC client.
