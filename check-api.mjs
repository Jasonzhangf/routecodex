import { ConfigParser } from 'routecodex-config-engine';
const parser = new ConfigParser();
const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(parser))
  .filter(name => typeof parser[name] === 'function' && !name.startsWith('_'));
console.log('ConfigParser methods:', methods);