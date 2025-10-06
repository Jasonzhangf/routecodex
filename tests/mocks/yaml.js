// CommonJS mock for 'yaml' to allow jest.spyOn on named export
module.exports = {
  parse: function (content) {
    // Naive parser stub; tests will spy and override behavior
    return { parsed: true, content };
  },
};

