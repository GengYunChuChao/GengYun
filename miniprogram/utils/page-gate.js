// One verification owns the data-loading callback across onLoad -> onShow.
// Hidden/unloaded page instances invalidate their callbacks, without cancelling a login handoff.
const auth = require('./auth')
function start(page, callback) {
  if (page._gatePending) return
  const operation = page._gateOperation = (page._gateOperation || 0) + 1
  page._gateActive = true
  page._gatePending = true
  page._gateClose = function () { callback(false) }
  callback(false)
  auth.requireLogin(function (verified) {
    if (page._gateActive === false || page._gateOperation !== operation) return
    page._gatePending = false
    callback(verified)
  })
}
function cancel(page) {
  page._gateActive = false
  page._gateOperation = (page._gateOperation || 0) + 1
  page._gatePending = false
  if (page._gateClose) page._gateClose()
  else page.setData({ gatePassed: false })
}
module.exports = { start, cancel }
