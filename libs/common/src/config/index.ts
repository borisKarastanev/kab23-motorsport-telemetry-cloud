// Note: `config.module.ts` is deliberately NOT exported here. It is imported by
// deep path (`@app/common/config/config.module`) everywhere — re-exporting it
// from the barrel would pull `config.schema`'s Joi validation into every module
// that wants any other helper.
export * from './cors-origin';
