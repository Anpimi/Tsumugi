export default {
  activate(api) {
    for (const contribution of api.contributions) {
      api.register(contribution.id, async (input, metadata) => {
        const binding = api.services[0];
        const response = await metadata.services.call(binding.handleId, 'service:你好 👩🏽‍💻', 'service-a');
        if (response.outcome.kind !== 'succeeded') throw new Error('Synthetic service failure');
        return {
          kind: 'succeeded',
          utf8: JSON.stringify({ grant: response.outcome.output.utf8, input: JSON.parse(input.utf8) }),
        };
      });
    }
  },
};
