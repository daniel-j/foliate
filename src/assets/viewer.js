/*
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/* global debounce, dispatch, isExternalURL, resolveURL, toPangoMarkup, ePub */

let book, rendition
let locations
let searchResults
let clearSelection
let selectionData
let followLink = () => {}, footnoteEnabled = false
let autohideCursor, myScreenX, myScreenY, cursorHidden
let cfiToc = []

// check whether the page is zoomed
let windowSize
const zoomed = () => !((windowSize || window.outerWidth) === window.innerWidth)

// redraw annotations on view changes
// so that they would be rendered at the new, correct positions
const redrawAnnotations = () =>
    rendition.views().forEach(view => view.pane ? view.pane.render() : null)

// should not update slider position if a relocation event is triggered by the slider
let shouldUpdateSlider = true
const gotoPercentage = percentage => {
    shouldUpdateSlider = false
    rendition.display(book.locations.cfiFromPercentage(percentage))
}

// handle internal links from GtkLabel
const gotoURI = uri => {
    if (isExternalURL(uri)) {
        // external links are already opened by default; do nothing
        return false
    } else {
        dispatch({
            type: 'link-internal',
            payload: rendition.currentLocation().start.cfi
        })
        rendition.display(uri)
        return true
    }
}

// find in book
const doSearch = q =>
    Promise.all(book.spine.spineItems.map(item =>
        item.load(book.load.bind(book))
            .then(item.find.bind(item, q))
            .finally(item.unload.bind(item))))
        .then(results =>
            Promise.resolve([].concat.apply([], results)))
const doChapterSearch = q => {
    const item = book.spine.get(rendition.location.start.cfi)
    return item.load(book.load.bind(book))
        .then(item.find.bind(item, q))
        .finally(item.unload.bind(item))
}
const search = (q, inChapter) => {
    q = decodeURI(q)
    return (inChapter ? doChapterSearch(q) : doSearch(q))
        .then(results => {
            clearSearch()
            searchResults = results
            dispatch({ type: 'search-results', payload: q })
            results.forEach(({ cfi }) =>
                rendition.annotations.underline(cfi, {}, () => {}, 'ul', {
                    'stroke-width': '3px',
                    stroke: 'red', 'stroke-opacity': 0.8, 'mix-blend-mode': 'multiply'
                }))
        })
}
const clearSearch = () => {
    if (searchResults) searchResults.forEach(({ cfi }) =>
        rendition.annotations.remove(cfi, 'underline'))
}

const getCfiFromHref = async (href, currentHref) => {
    const [page, id] = href.split('#')
    const pageHref = currentHref ? resolveURL(page, currentHref) : href
    const item = book.spine.get(pageHref)
    await item.load(book.load.bind(book))
    const el = id ? item.document.getElementById(id) : item.document.body
    return item.cfiFromElement(el)
}

const getSectionfromCfi = cfi => {
    const CFI = new ePub.CFI()
    const index = cfiToc.findIndex(el => el ? CFI.compare(cfi, el.cfi) <= 0 : false)
    return cfiToc[(index !== -1 ? index : cfiToc.length) - 1]
        || { label: book.package.metadata.title, href: '', cfi: '' }
}

// create a range cfi from two cfi locations
// adapted from https://github.com/futurepress/epub.js/blob/be24ab8b39913ae06a80809523be41509a57894a/src/epubcfi.js#L502
const makeRangeCfi = (a, b) => {
    const CFI = new ePub.CFI()
    const start = CFI.parse(a), end = CFI.parse(b)
    const cfi = {
        range: true,
        base: start.base,
        path: {
            steps: [],
            terminal: null
        },
        start: start.path,
        end: end.path
    }
    const len = cfi.start.steps.length
    for (let i = 0; i < len; i++) {
        if (CFI.equalStep(cfi.start.steps[i], cfi.end.steps[i])) {
            if (i == len - 1) {
                // Last step is equal, check terminals
                if (cfi.start.terminal === cfi.end.terminal) {
                    // CFI's are equal
                    cfi.path.steps.push(cfi.start.steps[i])
                    // Not a range
                    cfi.range = false
                }
            } else cfi.path.steps.push(cfi.start.steps[i])
        } else break
    }
    cfi.start.steps = cfi.start.steps.slice(cfi.path.steps.length)
    cfi.end.steps = cfi.end.steps.slice(cfi.path.steps.length)

    return 'epubcfi(' + CFI.segmentString(cfi.base)
        + '!' + CFI.segmentString(cfi.path)
        + ',' + CFI.segmentString(cfi.start)
        + ',' + CFI.segmentString(cfi.end)
        + ')'
}

// text of the visible page for text-to-speech
const speakCurrentPage = () => {
    const currentLoc = rendition.currentLocation()
    book.getRange(makeRangeCfi(currentLoc.start.cfi, currentLoc.end.cfi))
        .then(range => dispatch({
            type: 'speech-start',
            payload: {
                text: range.toString(),
                nextPage: !currentLoc.atEnd
            }
        }))
}
const speakSelection = () => dispatch({
    type: 'speech-start',
    payload: {
        text: selectionData.text,
        nextPage: false
    }
})

const addAnnotation = (cfiRange, color) => {
    rendition.annotations.remove(cfiRange, 'highlight')
    rendition.annotations.highlight(cfiRange, {}, e => {
        const elRect = e.target.getBoundingClientRect()
        dispatch({
            type: 'annotation-menu',
            payload: {
                cfiRange,
                position: {
                    left: elRect.left,
                    right: elRect.right,
                    top: elRect.top,
                    bottom: elRect.bottom
                }
            }
        })
    }, 'hl', { fill: color, 'fill-opacity': 0.25, 'mix-blend-mode': 'multiply' })
}

const openBook = (fileName, inputType) => {
    book = ePub()
    book.open(decodeURI(fileName), inputType) // works for non-flatpak
        .catch(() => book.open(fileName, inputType)) // works for flatpak
        .catch(() => dispatch({ type: 'book-error' }))
    book.ready.then(() => dispatch({ type: 'book-ready' }))

    // set the correct URL based on the path to the nav or ncx file
    // fixes https://github.com/futurepress/epub.js/issues/469
    book.loaded.navigation.then(async navigation => {
        const hrefList = []
        const path = book.packaging.navPath || book.packaging.ncxPath
        const f = x => {
            x.label = x.label.trim()
            x.href = resolveURL(x.href, path)
            hrefList.push(x)
            x.subitems.forEach(f)
        }
        navigation.toc.forEach(f)

        // convert hrefs to CFIs for better TOC with anchor support
        cfiToc = await Promise.all(hrefList.map(async ({ label, href }) => {
            try {
                const result = await getCfiFromHref(href)
                const cfi = new ePub.CFI(result)
                cfi.collapse(true)
                return {
                    label,
                    href,
                    cfi: cfi.toString()
                }
            } catch (e) {
                return null
            }
        }))
        cfiToc.sort(new ePub.CFI().compare)
    })

    book.loaded.metadata.then(metadata => {
        if (metadata.description)
            metadata.description = toPangoMarkup(metadata.description)
    })
}

const display = (continuous, lastLocation, cached) => {
    rendition = continuous
        ? book.renderTo(document.body,
            { manager: 'continuous', flow: 'scrolled', width: '100%' })
        : book.renderTo('viewer', { width: '100%' })

    // HACK: no idea why but have to do it twice
    // otherwise it will fail, but only on rare occassions  ¯\_(ツ)_/¯
    const displayed = rendition.display(lastLocation)
        .then(() => rendition.display(lastLocation))

    const getPercentage = () => {
        try { // ¯\_(ツ)_/¯
            return rendition.currentLocation().start.percentage
        } catch(e) {
            return rendition.location.start.percentage
        }
    }
    if (cached) {
        book.locations.load(cached)
        displayed
            .then(() => dispatch({ type: 'book-displayed' }))
            .then(() => dispatch({
                type: 'locations-ready',
                payload: {
                    percentage: getPercentage(),
                    total: book.locations.total,
                    language: book.package.metadata.language
                }
            }))
    } else {
        displayed
            .then(() => dispatch({ type: 'book-displayed' }))
            .then(() => book.locations.generate(1600))
            .then(() => locations = book.locations.save())
            .then(() => dispatch({
                type: 'locations-generated',
                payload: {
                    percentage: getPercentage(),
                    total: book.locations.total,
                    language: book.package.metadata.language
                }
            }))
    }

    // get book cover for "about this book" dialogue
    book.loaded.resources
        .then(resources => resources.createUrl(book.cover))
        .then(blobUrl => fetch(blobUrl))
        .then(res => res.blob())
        .then(blob => {
            const reader = new FileReader()
            reader.readAsDataURL(blob)
            reader.onloadend = () => dispatch({
                type: 'cover',
                payload: reader.result.split(',')[1]
            })
        })
        .catch(() => dispatch({ type: 'cover', payload: null }))
}

const setupRendition = continuous => {
    let isSelecting = false

    if (!continuous) rendition.on("layout", layout =>
        document.getElementById('divider').style.display =
            layout.spread && document.getElementById('viewer').clientWidth >= 800
                ? 'block' : 'none')

    rendition.on('rendered', () => redrawAnnotations())

    rendition.on('relocated', location => {
        if (shouldUpdateSlider)
            dispatch({
                type: 'update-slider',
                payload: location.start.percentage
            })
        else shouldUpdateSlider = true
        dispatch({
            type: 'relocated',
            payload: {
                atStart: location.atStart,
                atEnd: location.atEnd,
                cfi: location.start.cfi,
                index: book.spine.get(location.start.cfi).index
            }
        })

        // find current TOC item based on CFI
        const cfi = location.end.cfi
        const section = getSectionfromCfi(cfi)
        dispatch({ type: 'section', payload: section.href })
    })

    const getRect = (rect, frame) => {
        const viewElementRect = frame.getBoundingClientRect()
        const left = rect.left + viewElementRect.left
        const right = rect.right + viewElementRect.left
        const top = rect.top + viewElementRect.top
        const bottom = rect.bottom + viewElementRect.top
        return { left, right, top, bottom }
    }

    rendition.hooks.content.register((contents, /*view*/) => {
        const frame = contents.document.defaultView.frameElement
        const html = contents.document.documentElement
        if (!html.getAttribute('lang') && book.package.metadata.language)
            html.setAttribute('lang', book.package.metadata.language)

        // hide EPUB 3 aside footnotes
        const asides = contents.document.querySelectorAll('aside')
        Array.from(asides).forEach(aside => {
            const type = aside.getAttribute('epub:type')
            if (type === 'footnote') aside.style.display = 'none'
        })

        const links = contents.document.querySelectorAll('a:link')
        Array.from(links).forEach(link => {
            link.addEventListener('click', async e => {
                e.stopPropagation()
                e.preventDefault()
                followLink = () => {
                    dispatch({
                        type: 'link-internal',
                        payload: rendition.currentLocation().start.cfi
                    })
                    link.onclick()
                }

                const type = link.getAttribute('epub:type')
                const href = link.getAttribute('href')
                if (isExternalURL(href))
                    dispatch({ type: 'link-external', payload: href })
                else if (type !== 'noteref' && !footnoteEnabled)
                    followLink()
                else {
                    const [page, id] = href.split('#')
                    const pageHref = resolveURL(page,
                        book.spine.spineItems[contents.sectionIndex].href)
                    const item = book.spine.get(pageHref)
                    if (item) await item.load(book.load.bind(book))

                    let el = (item && item.document ? item.document : contents.document)
                        .getElementById(id)
                    if (!el) return followLink()

                    // this bit deals with situations like
                    //     <p><sup><a id="note1" href="link1">1</a></sup> My footnote</p>
                    // where simply getting the ID or its parent would not suffice
                    // although it would still fail to extract useful texts for some books
                    const isFootnote = el => {
                        const nodeName = el.nodeName.toLowerCase()
                        return [
                            'a', 'span', 'sup', 'sub',
                            'em', 'strong', 'i', 'b',
                            'small', 'big'
                        ].every(x => x !== nodeName)
                    }
                    if (!isFootnote(el)) {
                        while (true) {
                            const parent = el.parentElement
                            if (!parent) break
                            el = parent
                            if (isFootnote(parent)) break
                        }
                    }

                    if (item) item.unload()
                    if (el.innerText.trim()) dispatch({
                        type: 'footnote',
                        payload: {
                            footnote: toPangoMarkup(el.innerHTML, pageHref),
                            // footnotes matching this would be hidden (see above)
                            // and so one cannot navigate to them
                            canFollow: !(el.nodeName === 'aside'
                                && el.getAttribute('epub:type') === 'footnote'),
                            position: getRect(e.target.getBoundingClientRect(), frame)
                        }
                    })
                    else followLink()
                }
            }, true)
        })

        const imgs = contents.document.querySelectorAll('img')
        Array.from(imgs).forEach(img => img.addEventListener('click', e =>
            fetch(img.src)
                .then(res => res.blob())
                .then(blob => {
                    const reader = new FileReader()
                    reader.readAsDataURL(blob)
                    reader.onloadend = () => dispatch({
                        type: 'img',
                        payload: {
                            alt: img.getAttribute('alt'),
                            base64: reader.result.split(',')[1],
                            position: getRect(e.target.getBoundingClientRect(), frame)
                        }
                    })
                }), false))

        // handle selection
        contents.document.onmousedown = () => isSelecting = true
        contents.document.onmouseup = () => {
            isSelecting = false

            const selection = contents.window.getSelection()

            if (!selection.rangeCount)
                return // see https://stackoverflow.com/q/22935320

            const range = selection.getRangeAt(0)
            if (range.collapsed) return

            const text = selection.toString().trim().replace(/\n/g, ' ')
            if (text === '') return

            const cfiRange = new ePub.CFI(range, contents.cfiBase).toString()

            selectionData = {
                language: book.package.metadata.language,
                text,
                cfiRange
            }
            clearSelection = () => contents.window.getSelection().removeAllRanges()

            const { left, right, top, bottom } =
                getRect(selection.getRangeAt(0).getBoundingClientRect(), frame)

            dispatch({
                type: 'selection',
                payload: {
                    left, right, top, bottom,
                    isSingle: text.split(' ').length === 1
                }
            })
        }

        // auto-hide cursor
        let timeout
        const hideCursor = () => {
            contents.document.documentElement.style.cursor = 'none'
            cursorHidden = true
        }
        const showCursor = () =>  {
            contents.document.documentElement.style.cursor = 'auto'
            cursorHidden = false
        }
        if (cursorHidden) hideCursor()
        contents.document.documentElement.addEventListener('mousemove', e => {
            // check whether the mouse actually moved
            // or the event is just triggered by something else
            if (e.screenX === myScreenX && e.screenY === myScreenY) return
            myScreenX = e.screenX, myScreenY = e.screenY
            showCursor()
            if (timeout) clearTimeout(timeout)
            if (autohideCursor) timeout = setTimeout(hideCursor, 1000)
        }, false)
    })

    // go to the next page when selecting to the end of a page
    // this makes it possible to select across pages
    rendition.on('selected', debounce(cfiRange => {
        if (!isSelecting || rendition.settings.flow === 'scrolled-doc') return
        const selCfi = new ePub.CFI(cfiRange)
        selCfi.collapse()
        const CFI = new ePub.CFI()
        if (CFI.compare(selCfi, rendition.currentLocation().end.cfi) >= 0)
            rendition.next()
    }, 1000))

    // scroll through pages
    if (!continuous) {
        const onwheel = debounce(event => {
            if (zoomed() || rendition.settings.flow === 'scrolled-doc') return
            const { deltaX, deltaY } = event
            if (Math.abs(deltaX) > Math.abs(deltaY)) {
                if (deltaX > 0) rendition.next()
                else if (deltaX < 0) rendition.prev()
            } else {
                if (deltaY > 0) rendition.next()
                else if (deltaY < 0) rendition.prev()
            }
            event.preventDefault()
        }, 100, true)
        document.documentElement.onwheel = onwheel
    }

    // keyboard shortcuts
    const handleKeydown = event => {
        if (zoomed()) return
        const paginated = !continuous && rendition.settings.flow !== 'scrolled-doc'
        const k = event.key
        if (k === 'ArrowLeft') rendition.prev()
        else if(k === 'ArrowRight') rendition.next()
        else if (k === 'Backspace') {
            if (paginated) rendition.prev()
            else window.scrollBy(0, -window.innerHeight)
        } else if (event.shiftKey && k === ' ' || k === 'ArrowUp' || k === 'PageUp') {
            if (paginated) rendition.prev()
        } else if (k === ' ' || k === 'ArrowDown' || k === 'PageDown') {
            if (paginated) rendition.next()
        }
    }
    rendition.on('keydown', handleKeydown)
    document.addEventListener('keydown', handleKeydown, false)
}

dispatch({ type: 'can-open' })
