import { collectCustomPayloadCarrierOwnerQueryability } from './custom-payload-carrier-owner-queryability-lib.mjs';

const results = collectCustomPayloadCarrierOwnerQueryability();
const failures = [];

for (const group of results) {
  if (group.id === 'sse_prefix') {
    if (group.files.length > 0) {
      failures.push(`${group.id} must have zero runtime files, found ${group.files.length}`);
    }
    continue;
  }

  if (group.summary.missingOwnerCount > 0) {
    failures.push(`${group.id} has ${group.summary.missingOwnerCount} runtime files without function-map owner`);
  }
  if (group.summary.missingVerificationCount > 0) {
    failures.push(`${group.id} has ${group.summary.missingVerificationCount} runtime files without verification-map coverage`);
  }
}

if (failures.length > 0) {
  console.error('[verify:custom-payload-carrier-owner-queryability] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  for (const group of results) {
    for (const entry of group.files) {
      const needsOwner = entry.ownerState === 'missing-owner';
      const needsVerification = entry.verificationMatches.length === 0;
      if (!needsOwner && !needsVerification) {
        continue;
      }
      const reasons = [];
      if (needsOwner) {
        reasons.push('missing-owner');
      }
      if (needsVerification) {
        reasons.push('missing-verification');
      }
      console.error(`- ${group.id} ${entry.file} [${reasons.join(', ')}]`);
    }
  }
  process.exit(1);
}

console.log('[verify:custom-payload-carrier-owner-queryability] ok');
for (const group of results) {
  console.log(
    `- ${group.id}: files=${group.files.length} unique-owner=${group.summary.uniqueOwnerCount} ambiguous-owner=${group.summary.ambiguousOwnerCount} missing-owner=${group.summary.missingOwnerCount} missing-verification=${group.summary.missingVerificationCount}`
  );
}
