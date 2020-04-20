const { Transform, Fragment, ReplaceChildren, queueWriteInstruction, Copy } = require('replicator-xml')

module.exports.transforms = [
  new Transform('//c', 'default', async node => {
    return (
      <>
        <d />
        <Copy item={node}>
          <ReplaceChildren item={node} mode='default' />
        </Copy>
      </>
    )
  })
]