import { collectCustomPayloadCarrierOwnerQueryability } from './custom-payload-carrier-owner-queryability-lib.mjs';

console.log('[audit-custom-payload-carrier-owner-queryability] report');

for (const group of collectCustomPayloadCarrierOwnerQueryability()) {
  console.log(`\n## ${group.title}`);
  console.log(`runtime files=${group.files.length}`);

  for (const entry of group.files) {
    const sampleSummary = entry.samples
      .map((sample) => `L${sample.line}:${sample.matches.join(',')}`)
      .join(' | ');
    console.log(`- ${entry.file} [${entry.ownerState}]`);
    console.log(`  samples: ${sampleSummary}`);
    if (entry.ownerMatches.length === 0) {
      console.log('  function-map owner: none');
    } else {
      const summary = entry.ownerMatches
        .map((match) => `${match.featureId} (${match.reasons.join('; ')})`)
        .join(' | ');
      console.log(`  function-map owner: ${summary}`);
    }
    if (entry.collaboratorMatches.length === 0) {
      console.log('  function-map collaborators: none');
    } else {
      const summary = entry.collaboratorMatches
        .map((match) => `${match.featureId} (${match.reasons.join('; ')})`)
        .join(' | ');
      console.log(`  function-map collaborators: ${summary}`);
    }
    if (entry.verificationMatches.length === 0) {
      console.log('  verification-map: none');
    } else {
      const summary = entry.verificationMatches
        .map((match) => `${match.featureId} (${match.reasons.join('; ')})`)
        .join(' | ');
      console.log(`  verification-map: ${summary}`);
    }
  }

  console.log(
    `summary unique-owner=${group.summary.uniqueOwnerCount} ambiguous-owner=${group.summary.ambiguousOwnerCount} missing-owner=${group.summary.missingOwnerCount} missing-verification=${group.summary.missingVerificationCount}`
  );
}
