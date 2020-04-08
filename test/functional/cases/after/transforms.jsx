const { Transform, Fragment, ReplaceChildren, queueWriteInstruction, Copy } = require('replicator')

module.exports.transforms = [
  new Transform('//c', 'default', async node => {
    return (
      <>
        <Copy item={node}>
          <ReplaceChildren item={node} mode='default' />
        </Copy>
        <d />
      </>
    )
  })
]