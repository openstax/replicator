const { Transform, Fragment, queueWriteInstruction, Copy } = require('replicator-xml')

module.exports.transforms = [
  new Transform('//h2', 'default', async (node, { getCount, allHeaders }) => {
    const count = getCount({within: allHeaders, to: node})
    const textNode = (await node.children())[0]
    return (
      <Copy item={node}>
        {`${count} - `}<Copy item={textNode} />
      </Copy>
    )
  }),
  new Transform('//li', 'default', async (node, { getCount, allHeaders, allHeadersItems, getPrecedingUnchecked }) => {
    // Hmmmm this is not a very self-explanatory function, requires `within` to be already sorted in document-order (hence 'Unchecked')
    const myHeader = getPrecedingUnchecked({within: allHeaders, to: node})
    const headerCount = getCount({within: allHeaders, to: myHeader})
    const itemCount = getCount({within: allHeadersItems, to: node, from: myHeader})
    const textNode = (await node.children())[0]
    return (
      <Copy item={node}>
        {`${headerCount}.${itemCount} `}<Copy item={textNode} />
      </Copy>
    )
  })
]