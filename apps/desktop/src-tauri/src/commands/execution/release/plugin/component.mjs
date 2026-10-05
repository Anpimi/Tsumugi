// Pure synthetic component for the installed Host/Core boundary. No filesystem,
// network, source checker, application internals or developer data are accessed.
import { createHash } from 'node:crypto';
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
export default {
  activate(api) {
    api.register(async payload => {
      const data = JSON.parse(payload.utf8);
      if (api.contribution.id === 'build') {
        const values = [ '\ufeff' + data.targets.map(t => t.text).join('\r\n') + '\r\n',
          JSON.stringify(data.targets.map(t => t.unitId)) ];
        return { kind: 'succeeded', utf8: JSON.stringify({
          profile: data.source.profile, sourceSetId: data.source.sourceSetId,
          targetLanguage: data.targetLanguage,
          artifacts: data.outputPaths.map((logicalPath, i) => ({
            id: `artifact-${i}`, logicalPath, role: 'output', utf8: values[i],
            sha256: digest(values[i]),
          })),
        }) };
      }
      const input = data.input;
      const output = data.output;
      if (output.artifacts.length !== 2 || output.targetLanguage !== input.targetLanguage
        || output.artifacts.some((a, i) => a.logicalPath !== input.outputPaths[i]
          || a.sha256 !== digest(a.utf8))
        || output.artifacts[0].utf8 !== '\ufeff' + input.targets.map(t => t.text).join('\r\n') + '\r\n'
        || JSON.stringify(JSON.parse(output.artifacts[1].utf8)) !== JSON.stringify(input.targets.map(t => t.unitId))) {
        throw new Error('Actual artifact mismatch');
      }
      return { kind: 'succeeded', utf8: JSON.stringify(data.requirements.map(r => ({
        key: r.key, inputDigest: r.inputDigest, scopeDigest: r.scopeDigest,
        coveredTargets: r.targets, outcome: { kind: 'completed', findings: [] },
      }))) };
    });
  },
};
