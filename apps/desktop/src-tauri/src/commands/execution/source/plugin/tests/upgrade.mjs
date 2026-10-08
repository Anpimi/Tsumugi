// Synthetic records profile v1 preserves one ASCII key, one UTF-8 text and the
// complete original CRLF artifact. Native key semantics have their own complete
// ContractRef: behavior 1 folds ASCII; behavior 2 preserves ASCII case. Neither
// policy claims compatibility with another identity family or a real format.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const configuration = JSON.parse(await readFile(new URL('./identity.json', import.meta.url), 'utf8'));
const version = configuration.behaviorVersion;
if (version !== 1 && version !== 2) throw new Error('Undeclared fixture identity policy');
const contract = (id, behaviorVersion = 1) => ({ id, schemaVersion: 1, behaviorVersion });
const profile = contract('example.upgrade-records');
const identity = contract('example.upgrade.key', version);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const equal = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const check = (condition, detail) => { if (!condition) throw new Error(detail); };

function extract(source) {
  check(equal(source.profile, profile) && source.artifacts.length === 1, 'Records profile mismatch');
  const artifact = source.artifacts[0];
  check(artifact.logicalPath === 'record.txt' && artifact.role === 'source'
    && artifact.sha256 === sha256(artifact.utf8), 'Captured artifact mismatch');
  const match = /^([A-Za-z]+)\t([^\r\n]+)\r\n$/.exec(artifact.utf8);
  check(match !== null, 'Expected exactly one ASCII-key UTF-8-text CRLF record');
  const key = match[1];
  const text = match[2];
  const start = Buffer.byteLength(key + '\t');
  const occurrence = {
    id: 'record-occurrence',
    source: { artifactId: artifact.id, range: { encoding: 'utf8-byte', start, end: start + Buffer.byteLength(text) } },
    nativeIdentity: {
      namespace: 'Synthetic.UpgradeRecords',
      value: version === 1 ? key.replace(/[A-Z]/g, character => character.toLowerCase()) : key,
      policy: identity,
      display: { value: key, source: { artifactId: artifact.id, range: { encoding: 'utf8-byte', start: 0, end: Buffer.byteLength(key) } } },
    },
  };
  return { profile, sourceSetId: source.sourceSetId, sourceLanguage: source.sourceLanguage,
    artifacts: source.artifacts, units: [{ id: 'record-unit', sourceRevisionId: 'record-proposal', text,
      occurrences: [occurrence], protectedFragments: [] }], order: ['record-occurrence'], relations: [], domainBlocks: [] };
}

// This verifier never calls extract or accepts a producer output as its oracle.
// It independently reads the captured record and checks every proposal field.
function verifySource(source, proposal) {
  check(equal(source.profile, profile) && source.artifacts.length === 1, 'Checker profile mismatch');
  const artifact = source.artifacts[0];
  const bytes = Buffer.from(artifact.utf8, 'utf8');
  const separator = bytes.indexOf(9);
  const key = bytes.subarray(0, separator).toString('ascii');
  const value = bytes.subarray(separator + 1, bytes.length - 2).toString('utf8');
  check(separator > 0 && /^[A-Za-z]+$/.test(key) && bytes.subarray(-2).equals(Buffer.from('\r\n'))
    && !value.includes('\r') && !value.includes('\n') && value.length > 0
    && artifact.logicalPath === 'record.txt' && artifact.role === 'source'
    && artifact.sha256 === sha256(artifact.utf8), 'Checker source grammar mismatch');
  const canonical = version === 1 ? key.toLowerCase() : key;
  const unit = proposal.units?.[0];
  const occurrence = unit?.occurrences?.[0];
  check(Object.keys(proposal).sort().join(',') === 'artifacts,domainBlocks,order,profile,relations,sourceLanguage,sourceSetId,units'
    && equal(proposal.profile, profile) && proposal.sourceSetId === source.sourceSetId
    && proposal.sourceLanguage === source.sourceLanguage && equal(proposal.artifacts, source.artifacts)
    && proposal.units.length === 1 && equal(proposal.order, [occurrence?.id])
    && equal(proposal.relations, []) && equal(proposal.domainBlocks, [])
    && Object.keys(unit).sort().join(',') === 'id,occurrences,protectedFragments,sourceRevisionId,text'
    && typeof unit.id === 'string' && unit.id.length > 0
    && typeof unit.sourceRevisionId === 'string' && unit.sourceRevisionId.length > 0 && unit.text === value
    && equal(unit.protectedFragments, []) && unit.occurrences.length === 1
    && Object.keys(occurrence).sort().join(',') === 'id,nativeIdentity,source'
    && typeof occurrence.id === 'string' && occurrence.id.length > 0
    && equal(occurrence.source, { artifactId: artifact.id,
      range: { encoding: 'utf8-byte', start: separator + 1, end: bytes.length - 2 } })
    && equal(occurrence.nativeIdentity, { namespace: 'Synthetic.UpgradeRecords', value: canonical, policy: identity,
      display: { value: key, source: { artifactId: artifact.id,
        range: { encoding: 'utf8-byte', start: 0, end: separator } } } }), 'Source proposal semantics mismatch');
}

function findings(requirements, faithful) {
  check(Array.isArray(requirements) && requirements.length === 1, 'Complete independent fixture rule required');
  return requirements.map(requirement => ({ key: requirement.key, inputDigest: requirement.inputDigest,
    scopeDigest: requirement.scopeDigest, coveredTargets: requirement.targets,
    outcome: { kind: 'completed', findings: faithful ? []
      : requirement.targets.map(target => ({ code: 'fixture-mismatch', target, severity: 'error' })) } }));
}

function build(input) {
  verifySource({ profile: input.source.profile, sourceSetId: input.source.sourceSetId,
    sourceLanguage: input.source.sourceLanguage, artifacts: input.source.artifacts }, input.source);
  check(input.targets.length === 1 && input.outputPaths.length === 1 && input.outputPaths[0] === 'zh-CN.txt'
    && input.targetLanguage === 'zh-CN' && input.configuration.length === 0
    && input.targets[0].unitId === input.source.units[0].id
    && input.targets[0].sourceRevisionId === input.source.units[0].sourceRevisionId, 'Fixed build scope mismatch');
  const utf8 = input.source.units[0].occurrences[0].nativeIdentity.display.value + '\t' + input.targets[0].text + '\r\n';
  return { profile, sourceSetId: input.source.sourceSetId, targetLanguage: input.targetLanguage,
    artifacts: [{ id: 'translated-record', logicalPath: input.outputPaths[0], role: 'translation', sha256: sha256(utf8), utf8 }] };
}

// Independent byte verifier: it parses the returned record, associates its
// target and compares the original key and exact selected UTF-8 text. It never
// calls build or fabricates a durable release.
function verifyArtifact(request) {
  const input = request.input;
  const output = request.output;
  verifySource({ profile: input.source.profile, sourceSetId: input.source.sourceSetId,
    sourceLanguage: input.source.sourceLanguage, artifacts: input.source.artifacts }, input.source);
  check(input.targets.length === 1 && input.outputPaths.length === 1 && input.configuration.length === 0
    && input.targets[0].unitId === input.source.units[0].id
    && input.targets[0].sourceRevisionId === input.source.units[0].sourceRevisionId
    && input.outputPaths[0] === 'zh-CN.txt' && input.targetLanguage === 'zh-CN', 'Artifact checker scope mismatch');
  const artifact = output.artifacts?.[0];
  check(equal(output.profile, profile) && output.sourceSetId === input.source.sourceSetId
    && output.targetLanguage === input.targetLanguage && output.artifacts.length === 1
    && artifact.id === 'translated-record' && artifact.role === 'translation'
    && artifact.logicalPath === input.outputPaths[0] && sha256(artifact.utf8) === artifact.sha256, 'Artifact association mismatch');
  const bytes = Buffer.from(artifact.utf8, 'utf8');
  const tab = bytes.indexOf(9);
  check(tab > 0 && bytes.subarray(-2).equals(Buffer.from('\r\n'))
    && bytes.subarray(0, tab).toString('utf8') === input.source.units[0].occurrences[0].nativeIdentity.display.value
    && bytes.subarray(tab + 1, bytes.length - 2).toString('utf8') === input.targets[0].text,
  'Actual artifact changed the key, exact selection or CRLF');
}

export default {
  activate(api) {
    api.onDispose(async () => {});
    const role = api.contribution.contract.id;
    api.register(async input => {
      check(!api.signal.aborted, 'Original worker was cancelled');
      const payload = JSON.parse(input.utf8);
      let output;
      if (role === 'example.upgrade.extract') output = extract(payload);
      else if (role === 'example.upgrade.source-check') {
        verifySource(payload.source, payload.proposal);
        output = findings(payload.requirements, true);
      } else if (role === 'example.upgrade.review-check') {
        verifySource({ profile: payload.source.profile, sourceSetId: payload.source.sourceSetId,
          sourceLanguage: payload.source.sourceLanguage, artifacts: payload.source.artifacts }, payload.source);
        const faithful = payload.selections.length === 1 && payload.targetLanguage === 'zh-CN'
          && payload.selections[0].unitId === payload.source.units[0].id
          && payload.selections[0].sourceRevisionId === payload.source.units[0].sourceRevisionId
          && typeof payload.selections[0].translationText === 'string' && payload.selections[0].translationText.length > 0;
        output = findings(payload.requirements, faithful);
      } else if (role === 'example.upgrade.build') output = build(payload);
      else if (role === 'example.upgrade.artifact-check') {
        verifyArtifact(payload);
        output = findings(payload.requirements, true);
      } else throw new Error('Undeclared fixture contribution');
      check(!api.signal.aborted, 'Original worker was cancelled before result');
      return { kind: 'succeeded', utf8: JSON.stringify(output) };
    });
  },
};
