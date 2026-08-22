import {
  PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY,
  PI_CONTRACT_SOURCE,
  PI_EXTENSION_EVENT_GROUPS,
  PI_NATIVE_CAPABILITY_GROUPS,
  PI_PACKAGE_MANIFEST_KEY,
  PI_PACKAGE_SURFACES,
  type PiNativeCapabilityGroup,
  type PiPackageSurfaceDefinition,
} from "../../../../src/pi-contract.ts";

export {
  PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY,
  PI_CONTRACT_SOURCE,
  PI_EXTENSION_EVENT_GROUPS,
  PI_NATIVE_CAPABILITY_GROUPS,
  PI_PACKAGE_SURFACES,
};

export type CatalogSection = "summary" | "surfaces" | "events" | PiNativeCapabilityGroup;

export function surfaceText(surface: PiPackageSurfaceDefinition): string {
  return [
    `# ${surface.id}`,
    "",
    surface.description,
    "",
    `Runtime directory: ${surface.directory ?? "package manifest"}`,
    `Pi discovery: ${surface.discovery}`,
    ...(surface.manifestKey ? [`Manifest field: package.json#${PI_PACKAGE_MANIFEST_KEY}.${surface.manifestKey}`] : []),
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

export function capabilitiesText(group?: PiNativeCapabilityGroup): string {
  const entries: Array<[string, readonly string[]]> = group
    ? [[group, PI_NATIVE_CAPABILITY_GROUPS[group]]]
    : Object.entries(PI_NATIVE_CAPABILITY_GROUPS);
  return entries.map(([name, capabilities]) => `${name}: ${capabilities.join(", ")}`).join("\n");
}

export function surfaceById(id: string): PiPackageSurfaceDefinition | undefined {
  return PI_PACKAGE_SURFACES.find((surface) => surface.id === id);
}

export function catalogSectionText(section: CatalogSection = "summary", id?: string): string {
  if (section === "surfaces") return id ? surfaceText(surfaceById(id) ?? PI_PACKAGE_SURFACES[0]!) : surfacesListText();
  if (section === "events") return eventsListText();
  if (section in PI_NATIVE_CAPABILITY_GROUPS) return capabilitiesText(section as PiNativeCapabilityGroup);
  return catalogText();
}

export function catalogText(): string {
  return [
    `pi-catalog — ${PI_CONTRACT_SOURCE.package} ${PI_CONTRACT_SOURCE.version}`,
    `Source: ${PI_CONTRACT_SOURCE.declarations}; ${PI_CONTRACT_SOURCE.docs}`,
    "",
    "Package surfaces:",
    surfacesListText(),
    "",
    "Native capability groups:",
    capabilitiesText(),
    "",
    "Command: /catalog [surfaces [id]|events|<capability-group>]",
  ].join("\n");
}
