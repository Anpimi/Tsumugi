export default {
  activate(api) {
    api.register(async (input, metadata) => {
      const binding = api.services[0];
      const response = await metadata.services.call(binding.handleId, 'service:你好 👩🏽‍💻', 'service-a');
      if (response.outcome.kind !== 'succeeded') throw new Error('Synthetic service failure');
      return {
        kind: 'succeeded',
        utf8: JSON.stringify({ grant: response.outcome.output.utf8, input: JSON.parse(input.utf8) }),
      };
    });
  },
};
