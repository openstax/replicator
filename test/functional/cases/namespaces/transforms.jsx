const { Transform, Fragment, queueWriteInstruction, Copy } = require('replicator-xml')

module.exports.transforms = [
  new Transform('//a', 'default', async (node) => {
    const NamespacedB = '{example.com}b'
    return (
      <Copy item={node}>
        <NamespacedB />
      </Copy>
    )
  })
]