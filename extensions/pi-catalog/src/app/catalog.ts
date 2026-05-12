import {
  PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY,
  PI_EXTENSION_EVENT_GROUPS,
  PI_PACKAGE_MANIFEST_KEY,
  PI_PACKAGE_SURFACES,
  type PiPackageSurfaceDefinition,
} from "../../../../src/pi-contract.ts";

export { PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY, PI_EXTENSION_EVENT_GROUPS, PI_PACKAGE_SURFACES };

export function toolNameFor(surface: PiPackageSurfaceDefinition): string {
  return `gentic_surface_${surface.id.replaceAll("-", "_")}`;
}

export function surfaceText(surface: PiPackageSurfaceDefinition): string {
  return [
    `# ${surface.id}`,
    "",
    surface.description,
    "",
    `Runtime directory: ${surface.directory ?? "package manifest"}`,
    `Pi discovery: ${surface.discovery}`,
    ...(surface.manifestKey ? [`Manifest field: package.json#${PI_PACKAGE_MANIFEST_KEY}.${surface.manifestKey}`] : []),
    "",
    "This is a first-class Gentic surface because Pi discovers it directly from package metadata.",
  ].join("\n");
}

export function surfacesListText(): string {
  return PI_PACKAGE_SURFACES.map((surface) => `${surface.id.padEnd(15)} ${surface.description}`).join("\n");
}

export function eventsListText(): string {
  return Object.entries(PI_EXTENSION_EVENT_GROUPS)
    .map(([group, events]) => `${group}: ${events.join(", ")}`)
    .join("\n");
}

export function surfaceById(id: string): PiPackageSurfaceDefinition | undefined {
  return PI_PACKAGE_SURFACES.find((surface) => surface.id === id);
}

export function catalogText(): string {
  return [
    "pi-catalog",
    "",
    "Surfaces:",
    surfacesListText(),
    "",
    "Commands: /catalog surfaces, /catalog surface <id>, /catalog events",
  ].join("\n");
}
