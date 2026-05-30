import type { DomainPlugin, DomainSlug } from "./types.js";

const plugins = new Map<DomainSlug, DomainPlugin>();

export function registerDomain(plugin: DomainPlugin): void {
  if (plugins.has(plugin.slug)) {
    throw new Error(`Domain "${plugin.slug}" is already registered`);
  }
  plugins.set(plugin.slug, plugin);
}

export function getDomain(slug: DomainSlug): DomainPlugin {
  const plugin = plugins.get(slug);
  if (!plugin) {
    throw new Error(`Domain "${slug}" is not registered`);
  }
  return plugin;
}

export function listDomains(): DomainPlugin[] {
  return Array.from(plugins.values());
}
