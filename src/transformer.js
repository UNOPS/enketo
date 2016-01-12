'use strict';

var Promise = require( 'lie' );
var fs = require( 'fs' );
var pkg = require( '../package' );
var crypto = require( 'crypto' );
var libxslt = require( 'libxslt' );
var libxmljs = libxslt.libxmljs;
var language = require( './language' );
var markdown = require( './markdown' );
var sheets = require( 'enketo-xslt' );
var debug = require( 'debug' )( 'transformer' );
var version = _getVersion();

/**
 * Performs XSLT transformation on XForm and process the result.
 *
 * @param  {{xform: string, theme: string}} survey Survey object with at least an xform property
 * @return {Promise}     promise
 */
function transform( survey ) {
    var xsltEndTime;
    var xformDoc;
    var startTime = new Date().getTime();

    return _parseXml( survey.xform )
        .then( function( doc ) {
            xformDoc = doc;

            return _transform( sheets.xslForm, xformDoc );
        } )
        .then( function( htmlDoc ) {
            htmlDoc = _replaceTheme( htmlDoc, survey.theme );
            htmlDoc = _replaceMediaSources( htmlDoc, survey.media );
            htmlDoc = _replaceLanguageTags( htmlDoc );
            survey.form = _renderMarkdown( htmlDoc );

            return _transform( sheets.xslModel, xformDoc );
        } )
        .then( function( xmlDoc ) {
            xmlDoc = _replaceMediaSources( xmlDoc, survey.media );

            survey.model = xmlDoc.root().get( '*' ).toString( false );

            delete survey.xform;
            delete survey.media;
            return survey;
        } );
}

/**
 * Performs a generic XSLT transformation
 * 
 * @param  {[type]} xslDoc libxmljs object of XSL stylesheet
 * @param  {[type]} xmlDoc libxmljs object of XML document
 * @return {Promise}       libxmljs result document object 
 */
function _transform( xslStr, xmlDoc ) {
    return new Promise( function( resolve, reject ) {
        libxslt.parse( xslStr, function( error, stylesheet ) {
            if ( error ) {
                reject( error );
            } else {
                stylesheet.apply( xmlDoc, function( error, result ) {
                    if ( error ) {
                        reject( error );
                    } else {
                        resolve( result );
                    }
                } );
            }
        } );
    } );
}

/**
 * Parses and XML string into a libxmljs object
 * 
 * @param  {string} xmlStr XML string
 * @return {Promise}       libxmljs result document object
 */
function _parseXml( xmlStr ) {
    var doc;

    return new Promise( function( resolve, reject ) {
        try {
            doc = libxmljs.parseXml( xmlStr );
            resolve( doc );
        } catch ( e ) {
            reject( e );
        }
    } );
}

/**
 * Replaces the form-defined theme
 * 
 * @param  {[type]} doc   libxmljs object
 * @param  {string} theme theme
 * @return {[type]}       libxmljs object
 */
function _replaceTheme( doc, theme ) {
    var formClassAttr, formClassValue,
        HAS_THEME = /(theme-)[^"'\s]+/;

    if ( !theme ) {
        return doc;
    }

    formClassAttr = doc.root().get( '/root/form' ).attr( 'class' );
    formClassValue = formClassAttr.value();

    if ( HAS_THEME.test( formClassValue ) ) {
        formClassAttr.value( formClassValue.replace( HAS_THEME, '$1' + theme ) );
    } else {
        formClassAttr.value( formClassValue + ' ' + 'theme-' + theme );
    }

    return doc;
}

/**
 * Replaces xformManifest urls with URLs according to an internal Enketo Express url format
 * 
 * @param  {[type]} xmlDoc   libxmljs object
 * @param  {*} manifest      json representation of XForm manifest
 * @return {Promise}         libxmljs object
 */
function _replaceMediaSources( xmlDoc, mediaMap ) {
    var formLogo;
    var formLogoEl;

    if ( !mediaMap ) {
        return xmlDoc;
    }

    // iterate through each element with a src attribute
    xmlDoc.find( '//*[@src]' ).forEach( function( mediaEl ) {
        var src = mediaEl.attr( 'src' ).value();
        var matches = src ? src.match( /jr:\/\/[\w-]+\/(.+)/ ) : null;
        var filename = matches && matches.length ? matches[ 1 ] : null;
        var replacement = filename ? mediaMap[ filename ] : null;
        if ( replacement ) {
            mediaEl.attr( 'src', replacement );
        }
    } );

    // add form logo <img> element if applicable
    formLogo = mediaMap[ 'form_logo.png' ];
    formLogoEl = xmlDoc.get( '//*[@class="form-logo"]' );
    if ( formLogo && formLogoEl ) {
        formLogoEl
            .node( 'img' )
            .attr( 'src', formLogo )
            .attr( 'alt', 'form logo' );
    }

    return xmlDoc;
}

/**
 * Replaces all lang attributes to the valid IANA tag if found.
 * Also add the dir attribute to the languages in the language selector.
 *
 * @see  http://www.w3.org/International/questions/qa-choosing-language-tags
 * 
 * @param  {[type]} doc libxmljs object
 * @return {[type]}     libxmljs object
 */
function _replaceLanguageTags( doc ) {
    var languageElements;
    var languages;
    var langSelectorElement;
    var defaultLang;

    languageElements = doc.find( '/root/form/select[@id="form-languages"]/option' );

    // List of parsed language objects
    languages = languageElements.map( function( el ) {
        var lang = el.text();
        return language.parse( lang, _getLanguageSampleText( doc, lang ) );
    } );

    // forms without itext and only one language, still need directionality info
    if ( languages.length === 0 ) {
        languages.push( language.parse( '', _getLanguageSampleText( doc, '' ) ) );
    }

    // add or correct dir and value attributes, and amend textcontent of options in language selector
    languageElements.forEach( function( el, index ) {
        el.attr( {
            'data-dir': languages[ index ].dir,
            'value': languages[ index ].tag
        } ).text( languages[ index ].desc );
    } );

    // correct lang attributes
    languages.forEach( function( lang ) {
        if ( lang.src === lang.tag ) {
            return;
        }
        doc.find( '/root/form//*[@lang="' + lang.src + '"]' ).forEach( function( el ) {
            el.attr( {
                lang: lang.tag
            } );
        } );
    } );

    // correct default lang attribute
    langSelectorElement = doc.get( '/root/form/*[@data-default-lang]' );
    if ( langSelectorElement ) {
        defaultLang = langSelectorElement.attr( 'data-default-lang' ).value();
        languages.some( function( lang ) {
            if ( lang.src === defaultLang ) {
                langSelectorElement.attr( {
                    'data-default-lang': lang.tag
                } );
                return true;
            }
            return false;
        } );
    }

    return doc;
}

/**
 * Obtains a non-empty hint text or other text sample of a particular form language.
 * 
 * @param  {[type]} doc  libxmljs object
 * @param  {string} lang language
 * @return {string}      the text sample
 */
function _getLanguageSampleText( doc, lang ) {
    // First find non-empty text content of a hint with that lang attribute.
    // If not found, find any span with that lang attribute.
    var langSampleEl = doc.get( '/root/form//span[contains(@class, "or-hint") and @lang="' + lang + '" and normalize-space()]' ) ||
        doc.get( '/root/form//span[@lang="' + lang + '" and normalize-space()]' );

    return ( langSampleEl && langSampleEl.text().trim().length ) ? langSampleEl.text() : 'nothing';
}

/**
 * Converts a subset of Markdown in all textnode children of labels and hints into HTML
 * 
 * @param  {[type]} htmlDoc libxmljs object
 * @return {[type]}     libxmljs object
 */
function _renderMarkdown( htmlDoc ) {
    var htmlStr;
    var replacements = {};

    htmlDoc.find( '/root/form//span[contains(@class, "question-label") or contains(@class, "or-hint")]' ).forEach( function( el, index ) {
        el.childNodes()
            .filter( _textNodesOnly )
            .forEach( function( textNode, i ) {
                var key;
                // text() will convert &gt; to >
                var original = textNode.text().replace( '<', '&lt;' ).replace( '>', '&gt;' );
                var rendered = markdown.toHtml( original );
                if ( original !== rendered ) {
                    key = '$$$' + index + '_' + i;
                    replacements[ key ] = rendered;
                    textNode.text( key );
                }
            } );
    } );

    // TODO: does this result in self-closing tags?
    htmlStr = htmlDoc.root().get( '*' ).toString( false );

    Object.keys( replacements ).forEach( function( key ) {
        var replacement = replacements[ key ];
        if ( replacement ) {
            htmlStr = htmlStr.replace( key, replacement );
        }
    } );

    return htmlStr;
}

function _textNodesOnly( node ) {
    return node.type() === 'text';
}

/**
 * gets a hash of the 2 XSL stylesheets
 * @return {string} hash representing version of XSL stylesheets
 */
function _getVersion() {
    return _md5( sheets.xslForm + sheets.xslModel + pkg.version );
}

/**
 * Calculate the md5 hash of a message.
 *
 * @param  {string|Buffer} message The string or buffer
 * @return {string}         The hash
 */
function _md5( message ) {
    var hash = crypto.createHash( 'md5' );
    hash.update( message );
    return hash.digest( 'hex' );
}

module.exports = {
    transform: transform,
    version: version
};