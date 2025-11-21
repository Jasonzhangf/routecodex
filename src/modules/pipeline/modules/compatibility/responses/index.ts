import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { ResponsesCompatibility } from './responses-compatibility.js';

CompatibilityModuleFactory.registerModuleType('responses-compatibility', ResponsesCompatibility as any);

