function createComboContext(opts) {
  return {
    body: opts.body,
    combo: opts.combo,
    settings: opts.settings ?? null,
    relayOptions: opts.relayOptions ?? null,
    log: opts.log
  };
}
export {
  createComboContext
};
