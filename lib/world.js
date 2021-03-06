'use strict'

const fs = require('fs')
const path = require('path')
const webdriver = require('selenium-webdriver')
const loader = require('node-glob-loader')
const until = require('selenium-webdriver').until
const chrome = require('selenium-webdriver/chrome')
const cheerio = require('cheerio')
const _ = require('lodash')
const basePageObject = {}
let defaultTimeout = 10000
const routes = []
const screenshotPath = 'screenshots'

const co = require('bluebird').coroutine

const service = new chrome.ServiceBuilder(require('chromedriver').path).build()
chrome.setDefaultService(service)

let driver

const getDriver = () => {
  if (!driver) {
    driver = new webdriver.Builder()
      .withCapabilities(webdriver.Capabilities.chrome())
      // .withCapabilities(webdriver.Capabilities.firefox())
      .build()
  }
  return driver
}

if (!fs.existsSync(screenshotPath)) {
  fs.mkdirSync(screenshotPath)
}

const getSelector = (config, id) => _.reduce(id.split(':'), (prev, current) => {
  let selector = prev[0]
  if (_.isArray(current)) {
    selector += ' ' + current[0]
    current = current[1]
  }
  if (_.isArray(prev[1])) {
    selector += ' ' + prev[1][0]
    prev = prev[1][1]
  } else {
    prev = prev[1]
  }
  const prop = _.camelCase(current)
  const obj = prev[prop]
  if (obj) {
    if (_.isString(obj)) {
      selector += ' ' + obj
    }
    selector = selector.trim()
    if (selector) {
      return [selector.trim(), obj]
    } else {
      return prev[prop]
    }
  } else {
    throw new Error(`Cannot find "${prop}" configured as a Component property"`)
  }
}, ['', config])

/** ------------------------ extend until --------------------------- **/

_.extend(until, {
  pageMatches: (page, world) => {
    const currentPage = page
    return new until.Condition(`for page to match "${currentPage}"`, co(function * () {
      const route = yield getRoute(currentPage)
      if (!route) {
        throw new Error(`Route is not defined for "${currentPage}" page`)
      }
      const page = yield getPageObject(world)
      return page.route.path === route.path
    }))
  },
  configuredInPage: (id, world) => new until.Condition(`for "${id}" to be configured in page`, co(function * () {
    const page = yield getPageObject(world)
    return getSelector(page.config, id)[0]
  })),
  foundInPage: (selector) => new until.Condition(`for $("${selector}") to be found in page`, co(function * () {
    return yield getDriver().findElement(webdriver.By.css(selector))
      .then(() => true)
      .catch(() => false)
  })),
  notFoundInPage: (selector) => new until.Condition(`for $("${selector}") to not be found in page`, co(function * () {
    return yield getDriver().findElement(webdriver.By.css(selector))
      .then(() => false)
      .catch(() => true)
  })),
  titleIs: (expectedTitle) => new until.Condition(`for "${expectedTitle}" to match page title`, co(function * () {
    const title = yield getDriver().getTitle()
    return title === expectedTitle
  })),
  browserReady: () => new until.Condition('for url to not equal data ', co(function * () {
    const url = yield getDriver().getCurrentUrl()
    return url !== 'data:,'
  }))
})

/** --------------------- co functions ------------------------ **/

const whenVisible = co(function * (el, timeout) {
  try {
    yield getDriver().wait(until.elementIsEnabled(el), timeout || defaultTimeout)
    yield getDriver().wait(until.elementIsVisible(el), timeout || defaultTimeout)
    return Promise.resolve(el)
  } catch (e) {
    el.getOuterHtml()
      .then((html) => {
        throw new Error(e.message + '\n' + html)
      })
  }
})

const whenHidden = co(function * (el, timeout) {
  try {
    yield getDriver().wait(until.elementIsEnabled(el), timeout || defaultTimeout)
    yield getDriver().wait(until.elementIsNotVisible(el), timeout || defaultTimeout)
    return Promise.resolve(el)
  } catch (e) {
    el.getOuterHtml()
      .then((html) => {
        throw new Error(e.message + '\n' + html)
      })
  }
})

const whenMatches = co(function * (el, text, timeout) {
  try {
    yield getDriver().wait(until.elementTextIs(el, text), timeout || defaultTimeout)
    return Promise.resolve(el)
  } catch (e) {
    el.getOuterHtml()
      .then((html) => {
        throw new Error(e.message + '\n' + html)
      })
  }
})

const whenTitleIs = co(function * (title, timeout) {
  yield getDriver().wait(until.titleIs(title), timeout || defaultTimeout)
  return Promise.resolve()
})

const whenPageIs = co(function * (page, world, timeout) {
  yield getDriver().wait(until.pageMatches(page, world), timeout || defaultTimeout)
  return Promise.resolve()
})

const whenBrowserReady = co(function * (world, timeout) {
  yield getDriver().wait(until.browserReady(), timeout || defaultTimeout)
  const url = yield getDriver().getCurrentUrl()
  return Promise.resolve(url)
})

/* Find the id in the config and use the selector to find the element in the dom */
const find = co(function * (id, world, timeout) {
  let selector = 'body'
  if (id) {
    yield getDriver().wait(until.configuredInPage(id, world), timeout || defaultTimeout)
    selector = getSelector(world.currentPage.config, id)[0]
  }
  yield getDriver().wait(until.foundInPage(selector), timeout || defaultTimeout)
  return getDriver().findElement(webdriver.By.css(selector))
})

/* Find the id in the config and use the selector to not-find the element in the dom */
const notFind = co(function * (id, world, timeout) {
  yield getDriver().wait(until.configuredInPage(id, world), timeout || defaultTimeout)
  const selector = getSelector(world.currentPage.config, id)[0]
  yield getDriver().wait(until.notFoundInPage(selector), timeout || defaultTimeout)
  return Promise.resolve()
})

/** --------------------- stuff ------------------------ **/

const loadRoutes = () =>
  routes.length ? Promise.resolve(routes) : new Promise((resolve) =>
    loader.load(path.join(process.cwd(), '/**/features/routes.js'), (data, name) => {
      if (name.indexOf('node_modules') === -1) {
        _.each(data, (component, name) => routes.unshift(_.assign({component: name}, component)))
      } })
      .then(() => resolve(routes)))

const matchedRoutes = (routes, val) => routes
  .filter((route) => !route.path ? false : (_.isArray(route.path) ? route.path : [route.path])
    .some((path) => (val === path.split('/')
        .map((part, index) => part[0] === ':' ? val.split('/')[index] : part)
        .join('/')
    ) ? route : false))

const getRoute = (val, prop) => loadRoutes()
  .then((routes) => {
    prop = prop || 'component'
    val = (prop === 'component') ? _.camelCase(val) : val
    let route = _(routes).find((route) => route[prop] === val)
    if (!route && prop === 'path') {
      const matched = matchedRoutes(routes, val)
      if (matched.length > 1) {
        throw new Error('Ambigous path ' + val + ' can match any of the routes ' + _.map(matched, _.property('component')).join(' and '))
      }
      route = matched[0]
    }
    return Promise.resolve(route)
  })

const getPageObject = (world) => new Promise((resolve, reject) => whenBrowserReady(world)
  .then((url) => Promise.resolve(url.split('?')[0]))
  .then((url) => getRoute(url, 'path')
    .then((route) => {
      if (!route) {
        throw new Error(`Route is not defined for "${url}"`)
      }
      const pageConfig = _.defaultsDeep(basePageObject, route.pageObject)
      const pageObject = {
        config: pageConfig
      }
      _.each(pageConfig, (val, prop) => {
        if (_.isFunction(val)) {
          pageObject[prop] = val.bind(pageObject)
        }
      })
      if (pageObject) {
        pageObject.route = route
        world.currentPage = pageObject
        return resolve(pageObject)
      }
    }))
  .catch(reject))

/** --------------------- World class --------------------- **/

const World = (() => {
  const data = {}

  class World {
    constructor () {
      this.find = (id, timeout) => find(id, this, timeout)
      this.notFind = (id, timeout) => notFind(id, this, timeout)
      this.whenPageIs = (page, timeout) => whenPageIs(page, this, timeout)
      this.whenTitleIs = whenTitleIs
      this.executeScript = getDriver().executeScript.bind(getDriver())
    }

    hover (id, delay, timeout) {
      return find(id, this, timeout)
        .then((el) => whenVisible(el, timeout)
          .then(() => getDriver().actions().mouseMove(el).perform())
          .then(() => getDriver().sleep(delay || 0))
          .then(() => Promise.resolve(el)))
    }

    click (id, retries, timeout) {
      const click = (retries) => find(id, this, timeout)
        .then((el) => whenVisible(el, timeout))
        .then((el) => el.click())
        .catch((err) => {
          if (retries) {
            return this.sleep(150)
              .then(() => this.scrollTo(id))
              .then(() => click(--retries))
          }
          throw err
        })
      return click(retries)
    }

    sendKeys (id, text, retries, timeout) {
      const sendKeys = (retries) => find(id, this, timeout)
        .then((el) => whenVisible(el, timeout))
        .then((el) => el.sendKeys(text))
        .catch((err) => {
          if (retries) {
            return this.sleep(150)
              .then(() => this.scrollTo(id))
              .then(() => sendKeys(--retries))
          }
          throw err
        })
      return sendKeys(retries)
    }

    scrollTo (id) {
      return this.find(id)
        .then((el) => {
          this.executeScript((el) => {
            function getOffset (elem) {
              var left = 0
              var top = 0
              var el = elem
              while (el && !isNaN(el.offsetLeft) && !isNaN(el.offsetTop)) {
                left += el.offsetLeft - el.scrollLeft
                top += el.offsetTop - el.scrollTop
                el = el.offsetParent
              }
              return {top: top, left: left}
            }

            var offset = getOffset(el)
            window.scroll(offset.left + 100, offset.top)
          }, el)
          return el
        })
    }

    getHtml (id, timeout) {
      return find(id, this, timeout)
        .then((el) => el.getAttribute('outerHTML'))
    }

    load (id, timeout) {
      return this.getHtml(id, timeout)
        .then((html) => Promise.resolve(cheerio.load(html)))
    }

    select (id, query, timeout) {
      return this.load(id, timeout)
        .then(($) => Promise.resolve($(':first-child ' + (query || ''))))
    }

    getText (id, timeout) {
      return find(id, this, timeout)
        .then((el) => whenVisible(el))
        .then((el) => el.getText())
    }

    getVal (id, timeout) {
      return find(id, this, timeout)
        .then((el) => whenVisible(el))
        .then((el) => el.getAttribute('value'))
    }

    whenVisible (id, timeout) {
      return find(id, this, timeout)
        .then((el) => whenVisible(el))
        .then((el) => Promise.resolve())
    }

    whenHidden (id, timeout) {
      return find(id, this, timeout)
        .then((el) => whenHidden(el))
        .then((el) => Promise.resolve())
    }

    whenTextMatches (id, text, timeout) {
      return find(id, this, timeout)
        .then((el) => whenVisible(el, timeout))
        .then((el) => whenMatches(el, text, timeout))
        .then((el) => Promise.resolve())
    }

    setSize (width, height) {
      return Promise.resolve(getDriver().manage().window().setSize(width, height))
    }

    sleep (delay) {
      return getDriver().sleep(delay || 0)
    }

    visit (page, params) {
      return getRoute(page)
        .then((route) => {
          if (!route) {
            throw new Error(`Route is not defined for "${page}" page`)
          }
          const paths = _.cloneDeep(_.isArray(route.path) ? route.path : route.path ? [route.path] : [])
          let routePath
          params = _.isArray(params) ? params : params ? [params] : []
          if (params.length) {
            paths.forEach((path) => {
              const p = _.cloneDeep(params)
              let count = p.length
              const parts = path.split('/').map((part) => {
                if (part[0] === ':') {
                  count--
                  return p.shift()
                } else {
                  return part
                }
              })
              if (count === 0) {
                routePath = parts.join('/')
              }
            })
          } else {
            routePath = paths.pop()
          }
          if (routePath) {
            return getDriver().get(routePath)
          }
          throw new Error(`Route is not defined for "${page}" page`)
        })
    }

    getData (id) {
      return Promise.resolve(data[_.camelCase(id)])
    }

    setData (id, val) {
      return Promise.resolve(data[_.camelCase(id)] = val)
    }

    hasData (id) {
      return Promise.resolve(data.indexOf(_.camelCase(id)) !== -1)
    }

  }

  return World
})()

/** --------------------- module exports ------------------------ **/

module.exports.World = World
module.exports.getDriver = getDriver
module.exports.env = require('../lib/env')
module.exports.hooks = require('../lib/hooks')
