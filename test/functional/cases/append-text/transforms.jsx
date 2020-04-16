const { Transform, Fragment, queueWriteInstruction, Copy } = require('replicator')

module.exports.transforms = [
  new Transform('//c/:text', 'default', async node => {
    return (
      <>
      Fancy <Copy item={node} />
      </>
    )
  })
]