/** Native diagnostic tools do not need the collector's provider or access credentials. */
export function subprocessEnvironment(source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  const protectedNames=new Set(['NEO_OPENAI_API_KEY','OPENAI_API_KEY','NEO_SERVICE_TOKEN']);
  // Environment variable names are case-insensitive on Windows.
  return Object.fromEntries(Object.entries(source).filter(([name])=>!protectedNames.has(name.toUpperCase())));
}
