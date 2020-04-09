module.exports.fixtures = async root => {
  const documentOrder = (node, other) => node.id() - other.id()

  const getCount = ({within, to, from}) => {
    const fromIndex = (from == null) ? -1 : within.findIndex(node => node.equals(from))
    const toIndex = within.findIndex(node => node.equals(to))
    return toIndex - fromIndex
  }
  const allHeaders = await root.select("//h2")
  // Hmmmm this is a bit weird too, would be nice to keep separate lists and not have to mix them here
  const allHeadersItems = (await root.select("//li")).concat(allHeaders).sort(documentOrder)
  const getPrecedingUnchecked = ({within, to}) => {
    return within.reduce((latest, current) => {
      return current.id() > to.id()
        ? latest
        : current
    })
  }
  return {
    getCount,
    allHeaders,
    allHeadersItems,
    getPrecedingUnchecked,
  }
}