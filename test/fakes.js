"use strict";

function fakeFetch(routes) {
  return async (url) => {
    if (!(url in routes)) throw new Error(`HTTP 404 ${url}`);
    const v = routes[url];
    if (v instanceof Error) throw v;
    return v;
  };
}

module.exports = { fakeFetch };
