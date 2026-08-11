function short(value, length = 7) {
  const text = String(value || '').trim();
  return text ? text.slice(0, length) : null;
}

export function getAppBuildInfo() {
  const commit = short(process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA);
  const deploymentId = String(process.env.VERCEL_DEPLOYMENT_ID || '').trim() || null;
  const branch = String(process.env.VERCEL_GIT_COMMIT_REF || '').trim() || null;
  const label = commit
    ? `git:${commit}`
    : deploymentId
      ? `deploy:${deploymentId.slice(0, 8)}`
      : (process.env.NODE_ENV === 'production' ? 'production-unknown' : 'local-dev');

  return {
    label,
    commit,
    deploymentId,
    branch,
    nodeEnv: process.env.NODE_ENV || null,
  };
}
