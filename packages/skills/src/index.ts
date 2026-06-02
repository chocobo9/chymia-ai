import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Resolves filesystem locations of the skills data (manifest.yaml + skills/*.md),
// which M11 populates. Consumers (M11 loaders in @choco/api) read from these paths.
const here = dirname(fileURLToPath(import.meta.url))

/** Root of the @choco/skills package (contains manifest.yaml and skills/). */
export const skillsPackageRoot: string = resolve(here, '..')

/** Absolute path to the skills manifest YAML. */
export const manifestPath: string = resolve(skillsPackageRoot, 'manifest.yaml')

/** Absolute path to the directory holding individual skill markdown files. */
export const skillsDir: string = resolve(skillsPackageRoot, 'skills')
