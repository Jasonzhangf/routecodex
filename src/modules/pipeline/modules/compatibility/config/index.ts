import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { ConfigCompatibility } from './config-compatibility.js';

CompatibilityModuleFactory.registerModuleType('config-compatibility', ConfigCompatibility as any);

export { ConfigCompatibility } from './config-compatibility.js';

