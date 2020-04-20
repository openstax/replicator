const { Transform, Fragment, queueWriteInstruction, Copy } = require('replicator-xml')

module.exports.transforms = [
  new Transform('//c/:text', 'default', async node => {
    const text = (await node.text()).trim()
    if (text.trim().length == 0) {
      return <Copy item={node} />
    }
    return (
      <>
      {`Fancy ${text}`}
      </>
    )
  })
]