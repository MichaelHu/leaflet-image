/* global L */

var queue = require('d3-queue').queue;

var cacheBusterDate = +new Date();

var exports = {};

exports.process = function(map, callback) {

    var hasMapbox = !!L.mapbox;

    var dimensions = map.getSize(),
        layerQueue = new queue(1);

    var canvas = document.createElement('canvas');
    canvas.width = dimensions.x;
    canvas.height = dimensions.y;
    var ctx = canvas.getContext('2d');

    // dummy canvas image when loadTile get 404 error
    // and layer don't have errorTileUrl
    var dummycanvas = document.createElement('canvas');
    dummycanvas.width = 1;
    dummycanvas.height = 1;
    var dummyctx = dummycanvas.getContext('2d');
    dummyctx.fillStyle = 'rgba(0,0,0,0)';
    dummyctx.fillRect(0, 0, 1, 1);

    // layers are drawn in the same order as they are composed in the DOM:
    // tiles, paths, and then markers
    map.eachLayer(drawTileLayer);
    if (map._pathRoot) {
        layerQueue.defer(handlePathRoot, map._pathRoot);
    } else if (map._panes) {
        var firstCanvas = map._panes.overlayPane.getElementsByTagName('canvas').item(0);
        if (firstCanvas) { layerQueue.defer(handlePathRoot, firstCanvas); }
    }

    map.eachLayer(drawMarkerLayer);
    // map.eachLayer(drawSophonMarkerLayer);
    layerQueue.defer( drawSophonMarkers );
    layerQueue.awaitAll(layersDone);

    // var __ts = +new Date();
    // console.log( JSON.stringify( exports.getMapSnapshotInfo( map ) ) );
    // console.log( +new Date() - __ts );









    function drawTileLayer(l) {
        if (l instanceof L.TileLayer) layerQueue.defer(handleTileLayer, l);
        else if (l._heat) layerQueue.defer(handlePathRoot, l._canvas);
    }

    function drawMarkerLayer(l) {
        if (l instanceof L.Marker && l.options.icon instanceof L.Icon) {
            layerQueue.defer(handleMarkerLayer, l);
        }
    }

    function drawSophonMarkerLayer(l) {
        if (L.Marker.isSophonPoint(l)) {
            layerQueue.defer(handleSophonMarker, l);
        }
    }

    function done() {
        callback(null, canvas);
    }

    function layersDone(err, layers) {
        if (err) throw err;
        layers.forEach(function (layer) {
            if (layer && layer.canvas) {
                ctx.drawImage(layer.canvas, 0, 0);
            }
        });
        done();
    }

    function handleTileLayer(layer, callback) {
        // `L.TileLayer.Canvas` was removed in leaflet 1.0
        var isCanvasLayer = (L.TileLayer.Canvas && layer instanceof L.TileLayer.Canvas),
            canvas = document.createElement('canvas');

        canvas.width = dimensions.x;
        canvas.height = dimensions.y;

        var ctx = canvas.getContext('2d'),
            bounds = map.getPixelBounds(),
            origin = map.getPixelOrigin(),
            zoom = map.getZoom(),
            tileSize = layer.options.tileSize;

        if (zoom > layer.options.maxZoom ||
            zoom < layer.options.minZoom ||
            // mapbox.tileLayer
            (hasMapbox &&
                layer instanceof L.mapbox.tileLayer && !layer.options.tiles)) {
            return callback();
        }

        var tileBounds = L.bounds(
            bounds.min.divideBy(tileSize)._floor(),
            bounds.max.divideBy(tileSize)._floor()),
            tiles = [],
            j, i,
            tileQueue = new queue(1);

        for (j = tileBounds.min.y; j <= tileBounds.max.y; j++) {
            for (i = tileBounds.min.x; i <= tileBounds.max.x; i++) {
                tiles.push(new L.Point(i, j));
            }
        }

        tiles.forEach(function (tilePoint) {
            var originalTilePoint = tilePoint.clone();

            if (layer._adjustTilePoint) {
                layer._adjustTilePoint(tilePoint);
            }

            // `layer._getTilePos()` internally uses `layer._level.origin`,
            // but `map.getPixelOrigin()` is not always equal to 
            // `layer._level.origin` when map is being zoomed.
            // by <https://github.com/MichaelHu>
            var tilePos = originalTilePoint
                    .scaleBy(new L.Point(tileSize, tileSize))
                    .subtract(bounds.min)
                    ;

            if (tilePoint.y >= 0) {
                if (isCanvasLayer) {
                    var tile = layer._tiles[tilePoint.x + ':' + tilePoint.y];
                    tileQueue.defer(canvasTile, tile, tilePos, tileSize);
                } else {
                    var url = addCacheString(layer.getTileUrl(tilePoint));
                    // console.log( url, tilePoint, tilePos );
                    tileQueue.defer(loadTile, url, tilePos, tileSize);
                }
            }
        });

        tileQueue.awaitAll(tileQueueFinish);

        function canvasTile(tile, tilePos, tileSize, callback) {
            callback(null, {
                img: tile,
                pos: tilePos,
                size: tileSize
            });
        }

        function loadTile(url, tilePos, tileSize, callback) {
            var im = new Image();
            im.crossOrigin = '';
            im.onload = function () {
                callback(null, {
                    img: this,
                    pos: tilePos,
                    size: tileSize
                });
            };
            im.onerror = function (e) {
                // use canvas instead of errorTileUrl if errorTileUrl get 404
                if (layer.options.errorTileUrl != '' && e.target.errorCheck === undefined) {
                    e.target.errorCheck = true;
                    e.target.src = layer.options.errorTileUrl;
                } else {
                    callback(null, {
                        img: dummycanvas,
                        pos: tilePos,
                        size: tileSize
                    });
                }
            };
            im.src = url;
        }

        function tileQueueFinish(err, data) {
            data.forEach(drawTile);
            callback(null, { canvas: canvas });
        }

        function drawTile(d) {
            ctx.drawImage(d.img, Math.floor(d.pos.x), Math.floor(d.pos.y),
                d.size, d.size);
        }
    }

    function handlePathRoot(root, callback) {
        var bounds = map.getPixelBounds(),
            origin = map.getPixelOrigin(),
            canvas = document.createElement('canvas');
        canvas.width = dimensions.x;
        canvas.height = dimensions.y;
        var ctx = canvas.getContext('2d');
        var pos = L.DomUtil.getPosition(root).subtract(bounds.min).add(origin);
        try {
            ctx.drawImage(root, pos.x, pos.y, canvas.width - (pos.x * 2), canvas.height - (pos.y * 2));
            callback(null, {
                canvas: canvas
            });
        } catch(e) {
            console.error('Element could not be drawn on canvas', root); // eslint-disable-line no-console
        }
    }




    function handleMarkerLayer(marker, callback) {
        var icon = marker._icon;
        if(icon && icon.src){
            handleImageMarker.apply(null, arguments);
        }
        else {
            callback(null);
        }
    }





    function handleSophonMarker(marker, callback) {
        if (!marker.getElement()) return;
        var pixelPoint = map.project(marker.getLatLng())
            , ele = marker.getElement()
            , canvas = document.createElement('canvas')
            , ctx = canvas.getContext('2d')
            , pixelBounds = map.getPixelBounds()
            , minPoint = new L.Point(pixelBounds.min.x, pixelBounds.min.y)
            , pos = pixelPoint.subtract(minPoint)
            , styles = L.Marker.getMarkerStyle( marker )
            ;

        canvas.width = dimensions.x;
        canvas.height = dimensions.y;

        // console.log(ele.style.transform);
        // console.log(window.getComputedStyle(ele));
        // console.log(pos);
        ctx.save();
        ctx.strokeStyle = styles['border-color'];
        ctx.lineWidth = 0.5; 
        ctx.beginPath();
        ctx.arc(
            pos.x
            , pos.y
            , parseInt(styles['height']) / 2
            , 0
            , 2 * Math.PI
            , true
        );
        ctx.stroke();
        ctx.fillStyle = styles['background-color'];
        ctx.fill();
        ctx.restore();

        callback(null, {
            canvas: canvas
        });
    }

    function drawSophonMarkers( callback ) {
        var markers = []
            , pixelBounds = map.getPixelBounds()
            , minPoint = new L.Point( pixelBounds.min.x, pixelBounds.min.y )
            ;

        map.eachLayer( function( marker ) {
            if (L.Marker.isSophonPoint( marker )) {
                var ele = marker.getElement();

                if ( !ele ) {
                    return;
                }

                var pixelPoint = map.project(marker.getLatLng())
                    , styles = L.Marker.getMarkerStyle( marker )
                    , pos = pixelPoint.subtract(minPoint)
                    ;
                
                markers.push( {
                    pos: pos
                    , styles: styles
                } );
            }
        } );

        if ( !markers.length ) {
            callback( null );
            return;
        }

        var canvas = document.createElement( 'canvas' )
            , ctx = canvas.getContext( '2d' )
            ;

        canvas.width = dimensions.x;
        canvas.height = dimensions.y;

        markers.forEach( function( marker ) {
            var pos = marker.pos
                , styles = marker.styles
                ;

            ctx.save();
            ctx.strokeStyle = styles['border-color'];
            ctx.lineWidth = 0.5; 
            ctx.beginPath();
            ctx.arc(
                pos.x
                , pos.y
                , parseInt(styles['height']) / 2
                , 0
                , 2 * Math.PI
                , true
            );
            ctx.stroke();
            ctx.fillStyle = styles['background-color'];
            ctx.fill();
            ctx.restore();

        } );

        callback( null, { canvas: canvas } );
    }

    function handleImageMarker(marker, callback){
        var canvas = document.createElement('canvas'),
            ctx = canvas.getContext('2d'),
            pixelBounds = map.getPixelBounds(),
            minPoint = new L.Point(pixelBounds.min.x, pixelBounds.min.y),
            pixelPoint = map.project(marker.getLatLng()),
            isBase64 = /^data\:/.test(marker._icon.src),
            url = isBase64 ? marker._icon.src : addCacheString(marker._icon.src),
            im = new Image(),
            options = marker.options.icon.options,
            size = options.iconSize,
            pos = pixelPoint.subtract(minPoint),
            anchor = L.point(options.iconAnchor || size && size.divideBy(2, true));

        if (size instanceof L.Point) size = [size.x, size.y];

        var x = Math.round(pos.x - size[0] + anchor.x),
            y = Math.round(pos.y - anchor.y);

        canvas.width = dimensions.x;
        canvas.height = dimensions.y;
        im.crossOrigin = '';

        im.onload = function () {
            ctx.drawImage(this, x, y, size[0], size[1]);
            callback(null, {
                canvas: canvas
            });
        };

        im.src = url;

        if (isBase64) im.onload();
    }

    function addCacheString(url) {
        // If it's a data URL we don't want to touch this.
        if (isDataURL(url) || url.indexOf('mapbox.com/styles/v1') !== -1) {
            return url;
        }
        // return url + ((url.match(/\?/)) ? '&' : '?') + 'cache=' + cacheBusterDate;
        return url;
    }

    function isDataURL(url) {
        var dataURLRegex = /^\s*data:([a-z]+\/[a-z]+(;[a-z\-]+\=[a-z\-]+)?)?(;base64)?,[a-z0-9\!\$\&\'\,\(\)\*\+\,\;\=\-\.\_\~\:\@\/\?\%\s]*\s*$/i;
        return !!url.match(dataURLRegex);
    }

};



exports.getMapSnapshotInfo = function( map ) {
    var info = { tiles: null, markerList: [] }
        , dimensions = map.getSize()
        , bounds = map.getPixelBounds()
        , zoom = map.getZoom()
        ;

    map.eachLayer( function( layer ) {
        var markerInfo;

        if ( layer instanceof L.TileLayer && !info.tiles ) {
            info.tiles = collectTileInfo( layer );
        }
        else if ( layer instanceof L.Marker 
            && layer.options.icon instanceof L.Icon ) {
            markerInfo = collectMarkerInfo( layer );
            if ( markerInfo ) {
                info.markerList.push( markerInfo );
            }
        }
    } );

    return info;

    function extractXY( url ) {
        var xReg = /[?&]x=(\d+)/
            , yReg = /[?&]y=(\d+)/
            , info = {}
            ;

        info.x = xReg.test( url ) ? RegExp.$1 : '';
        info.y = yReg.test( url ) ? RegExp.$1 : '';

        if ( info.x == '' || info.y == '' ) {
            throw new Error( 'leftlet-image-sophon: extractXY error' );
        }

        return [ info.x - 0 | 0, info.y - 0 | 0 ];
    }

    function collectTileInfo( layer ) {
        var tileSize = layer.options.tileSize
            , tileBounds = L.bounds(
                bounds.min.divideBy(tileSize)._floor()
                , bounds.max.divideBy(tileSize)._floor()
            )
            , leftTopTile = tileBounds.min
            , rightBottomTile = tileBounds.max
            , retInfo = {
                // tileType: `Satellite` or `Normal`
                type: map.getTileType ? map.getTileType() : 'Normal'
                , leftTop: extractXY( layer.getTileUrl( leftTopTile ) )
                , rightBottom: extractXY( layer.getTileUrl( rightBottomTile ) )
                , z: zoom
                , viewport: {
                }
            }
            // viewport's top-left relative to leftTopTile's top-left 
            , viewportLeftTop 
            ;

        viewportLeftTop = leftTopTile
            .scaleBy( new L.Point( tileSize, tileSize ) )
            .subtract( bounds.min )
            .scaleBy( new L.Point( -1, -1 ) )
            ;

        retInfo.viewport.leftTop = [
            viewportLeftTop.x - 0 | 0
            , viewportLeftTop.y - 0 | 0
        ];
        retInfo.viewport.rightBottom = [
            viewportLeftTop.x + dimensions.x - 0 | 0
            , viewportLeftTop.y + dimensions.y - 0 | 0
        ];

        return retInfo;
    }

    function rgb2Hex( rgb ) {
        var reg = /rgb\((\d+),(\d+),(\d+)\)/
            , r, g, b
            ;

        if ( reg.test( rgb.replace( /\s/g, '') ) ) {
            r = RegExp.$1;
            g = RegExp.$2;
            b = RegExp.$3;

            return (
                '#' 
                + ( r - 0 ).toString( 16 )
                + ( g - 0 ).toString( 16 )
                + ( b - 0 ).toString( 16 )
            );

        }

        return rgb;
    }

    function collectMarkerInfo( layer ) {
        var marker = layer 
            , ele = marker.getElement()
            ;

        if ( !ele ) {
            return null;
        }

        var pixelPoint = map.project(marker.getLatLng())
            , styles = L.Marker.getMarkerStyle( marker )
            , pos = pixelPoint.subtract( bounds.min )
            ;
        
        return {
            x: pos.x - 0 | 0
            , y: pos.y - 0 | 0
            , size: styles[ 'height' ].replace( /px/, '' ) / 2
            , backgroundColor: rgb2Hex( styles[ 'background-color' ] )
        };
    }
};

module.exports = exports;
