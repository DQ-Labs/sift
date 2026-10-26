// A minimal method + path router. Patterns are literal segments and
// `:name` parameters, each matching exactly one URL-decoded path segment.
export class Router {
  constructor() {
    this.routes = [];
  }

  add(methods, pattern, handler) {
    const segments = pattern === '/' ? [] : pattern.slice(1).split('/');
    this.routes.push({ methods: new Set([].concat(methods)), segments, handler });
    return this;
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  match(method, pathname) {
    const parts = pathname === '/' ? [] : pathname.slice(1).split('/');
    for (const route of this.routes) {
      if (!route.methods.has(method) || route.segments.length !== parts.length) continue;
      const params = matchSegments(route.segments, parts);
      if (params) return { handler: route.handler, params };
    }
    return null;
  }
}

function matchSegments(segments, parts) {
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.startsWith(':')) {
      if (!parts[i]) return null;
      try {
        params[segment.slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
    } else if (segment !== parts[i]) return null;
  }
  return params;
}
