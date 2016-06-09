var isects = require('../geojson-polygon-self-intersections');
var helpers = require('turf-helpers');
var within = require('turf-within');
var area = require('turf-area');

/**
* Takes a complex (i.e. self-intersecting) geojson polygon, and breaks it down into its composite simple, non-self-intersecting one-ring polygons.
*
* @module simplepolygon
* @param {Feature} feature input polygon. This feature may be unconform the {@link http://geojson.org/geojson-spec.html|geojson specs} in the sense that it's inner and outer rings may cross-intersect or self-intersect, that the outer ring must not contain the optional inner rings and that the winding number must not be positive for the outer and negative for the inner rings.
* @return {FeatureCollection} Feature collection containing the simple, non-self-intersecting one-ring polygon features that the complex polygon is composed of. These simple polygons have properties such as their parent polygon, winding number and net winding number.
*
* @example
* var poly = {
*   "type": "Feature",
*   "properties": {},
*   "geometry": {
*     "type": "Polygon",
*     "coordinates": [[[0,0],[2,0],[0,2],[2,2],[0,0]]]
*   }
* };
*
* var result = simplepolygon(poly);
*
* // =result
* // which will be a featureCollection of two polygons, one with coordinates [[[0,0],[2,0],[1,1],[0,0]]], parent -1, winding 1 and net winding 1, and one with coordinates [[[1,1],[0,2],[2,2],[1,1]]], parent -1, winding -1 and net winding -1
*/

/*
  This algorithm walks from intersections (i.e. a vertex of an input ring or a self- or cross-intersection of those ring(s)) to intersection over (rings and) edges in their original direction, and while walking traces simple, non-self-intersecting one-ring polygons by storing the vertices along the way. This is possible since each intersection knows which is the next one given the incomming walking edge. When walking, the algorithm also stores where it has walked (since we must only walk over each (part of an) edge once), and keeps track of intersections that are new and from where another walk (and hence simple polygon) could be initiated. The resulting simple, one-ring polygons cover all input edges exactly once and don't self- or cross-intersect (but can touch at intersections). Hence, they form a set of nested rings.

  Some notes on the algorithm:
  - We will talk about rings (arrays of [x,y]) and polygons (array of rings). The geojson spec requires rings to be non-self- and non-cross-intersecting, but here the intput rings can self- and cross-intersect (inter and intra ring). The output rings can't, since they are conform the spec. Therefore will talk about 'input rings' or simply 'rings' (non-conform), 'output rings' (conform) and more generally 'simple, non-self or cross-intersecting rings' (conform)
  - We say that a polygon self-intersects when it's rings either self-intersect of cross-intersect
  - Edges are oriented from their first to their second ring vertrex. Hence, ring i edge j goes from vertex j to j+1. This direction or orientation of an egde is kept unchanged during the algorithm. We will only walk along this direction
  - This algorithm employs the notion of 'pseudo-vertices' and 'intersections' as outlined in the article
  - We use the terms 'ring edge', 'ring vertex', 'self-intersection vertex', 'intersection' (which includes ring-vertex-intersection and self-intersection) and 'pseudo-vertex' (which includes 'ring-pseudo-vertex' and 'intersection-pseudo-vertex')
  - At an intersection of two edges, two pseudo-vertices (intersection-pseudo-vertices) are one intersection (self-intersection) is present
  - At a ring vertex, one pseudo-vertex (ring-pseudo-vertex) and one intersection (ring-intersection) is present
  - A pseudo-vertex has an incomming and outgoing (crossing) edge
  - The following objects are stored and passed by the index in the list between brackets: intersections (isectList) and pseudo-vertices (pseudoVtxListByRingAndEdge)
  - The algorithm checks of the input has no non-unique vertices. This is mainly to prevent self-intersecting input polygons such as [[0,0],[2,0],[1,1],[0,2],[1,3],[2,2],[1,1],[0,0]], whose self-intersections would not be detected. As such, many polygons which are non-simple, by the OGC definition, for other reasons then self-intersection, will not be allowed. An exception includes polygons with spikes or cuts such as [[0,0],[2,0],[1,1],[2,2],[0,2],[1,1],[0,0]], who are currently allowed and treated correctly, but make the output non-simple (by OGC definition). This could be prevented by checking for vertices on other edges.
  - The resulting component polygons are one-ring and simple (in the sense that their ring does not contain self-intersections) and two component simple polygons are either disjoint, touching in one or multiple vertices, or one fully encloses the other
  - This algorithm takes geojson as input, be was developped for a euclidean (and not geodesic) setting. If used in a geodesic setting, the most important consideration to make is the computation of intersection points (which is practice is only an isseu of the line segments are relatively long). Further we also note that winding numbers for area's larger than half of the globe are sometimes treated specially. All other concepts of this algorithm (convex angles, direction, ...) can be ported to a geodesic setting without problems.

  Complexity:
  Currently, intersections are computed using a slow but robust implementation
	For n line-segments and k self-intersections, this is O(n^2)
  This is one of the most expensive parts of the algorithm
  It can be optimised to O((n + k) log n) through Bentley–Ottmann algorithm (which is an improvement for small k (k < o(n2 / log n)))
  See possibly https://github.com/e-cloud/sweepline
  Also, this step could be optimised using a spatial index
	The complexity of the simplepolygon-algorithm itself can be decomposed as follows:
  It includes a sorting step for the (s = n+2*k) pseudo-vertices (O(s*log(s))),
  And a lookup comparing (n+k) intersections and (n+2*k) pseudo-vertices, with worst-case complexity O((n+2*k)*(n+k))
  This lookup could potentially be optimised using sorting or spatial index
  Additionally k is bounded by O(n^2)

  This code differs from the algorithms and nomenclature of the article it is insired on in the following way:
  - The code was written based on the article, and not ported from the enclosed C/C++ code
  - No constructors are used, except 'PseudoVtx' and 'Isect'
  - This implementation expanded the algorithm to polygons containing inner and outer rings
  - 'LineSegments' of the polygon (rings) are called 'edges' here, and are represented, when necessary, by the index of their first point
  - 'ringAndEdgeOut' is called 'l' in the article
  - 'PseudoVtx' is called 'nVtx'
  - 'Isect' is called 'intersection'
  - 'nxtIsectAlongEdgeIn' is called 'index'
  - 'ringAndEdge1' and 'ringAndEdge2' are named 'origin1' and 'origin2'
  - 'winding' is not implemented as a propoerty of an intersection, but as its own queue
  - 'pseudoVtxListByRingAndEdge' is called 'polygonEdgeArray'
  - 'pseudoVtxListByRingAndEdge' contains the ring vertex at its end as the last item, and not the ring vertex at its start as the first item
  - 'isectList' is called 'intersectionList'
  - 'isectQueue' is called 'intersectioQueue'
*/

module.exports = function(feature) {

  var debug = false;

  // Check input
  if (feature.type != "Feature") throw new Error("The input must a geojson object of type Feature");
  if ((feature.geometry === undefined) || (feature.geometry == null)) throw new Error("The input must a geojson object with a non-empty geometry");
  if (feature.geometry.type != "Polygon") throw new Error("The input must be a geojson Polygon");

  // Process input
  var numRings = feature.geometry.coordinates.length;
  var vertices = [];
  for (var i = 0; i < numRings; i++) {
    var ring = feature.geometry.coordinates[i];
    if (!ring[0].equals(ring[ring.length-1])) {
      ring.push(ring[0]) // Close input ring if it is not
    }
    vertices.push.apply(vertices,ring.slice(0,ring.length-1));
  }
  if (!vertices.isUnique()) throw new Error("The input polygon may not have duplicate vertices (except for the first and last vertex of each ring)");
  var numvertices = vertices.length; // number of input ring vertices, with the last closing vertices not counted

  // Compute self-intersections
  var selfIsectsData = isects(feature, function filterFn(isect, ring0, edge0, start0, end0, frac0, ring1, edge1, start1, end1, frac1, unique){
    return [isect, ring0, edge0, start0, end0, frac0, ring1, edge1, start1, end1, frac1, unique];
  });
  var numSelfIsect = selfIsectsData.length;

  // If no self-intersections are found, the input rings are the output rings. Hence, we must only compute their winding numbers, net winding numbers and (since ohers rings could lie outside the first ring) parents.
  if (numSelfIsect == 0) {
    var outputFeatureArray = [];
    for(var i = 0; i < numRings; i++) {
      outputFeatureArray.push(helpers.polygon([feature.geometry.coordinates[i]],{parent: -1, winding: windingOfRing(feature.geometry.coordinates[i])}));
    }
    var output = helpers.featureCollection(outputFeatureArray)
    determineParents();
    setNetWinding();
    return output;
  }

  // If self-intersections are found, we will compute the output rings with the help of two intermediate variables
  // First, we build the pseudo vertex list and intersection list
  // The Pseudo vertex list is an array with for each ring an array with for each edge an array containing the pseudo-vertices (as made by their constructor) that have this ring and edge as ringAndEdgeIn, sorted for each edge by their fractional distance on this edge. It's length hence equals numRings.
  var pseudoVtxListByRingAndEdge = [];
  // The intersection list is an array containing intersections (as made by their constructor). First all numvertices ring-vertex-intersections, then all self-intersections (intra- and inter-ring). The order of the latter is not important but is permanent once given.
  var isectList = [];
  // Adding ring-pseudo-vertices to pseudoVtxListByRingAndEdge and ring-vertex-intersections to isectList
  for (var i = 0; i < numRings; i++) {
    pseudoVtxListByRingAndEdge.push([]);
    for (var j = 0; j < feature.geometry.coordinates[i].length-1; j++) {
      // Each edge will feature one ring-pseudo-vertex in its array, on the last position. i.e. edge j features the ring-pseudo-vertex of the ring vertex j+1, which has ringAndEdgeIn = [i,j], on the last position.
    	pseudoVtxListByRingAndEdge[i].push([new PseudoVtx(feature.geometry.coordinates[i][(j+1).mod(feature.geometry.coordinates[i].length-1)], 1, [i, j], [i, (j+1).mod(feature.geometry.coordinates[i].length-1)], undefined)]);
      // The first numvertices elements in isectList correspond to the ring-vertex-intersections
      isectList.push(new Isect(feature.geometry.coordinates[i][j], [i, (j-1).mod(feature.geometry.coordinates[i].length-1)], [i, j], undefined, undefined, false, true));
    }
  }
  // Adding intersection-pseudo-vertices to pseudoVtxListByRingAndEdge and self-intersections to isectList
  for (var i = 0; i < numSelfIsect; i++) {
    // Adding intersection-pseudo-vertices made using selfIsectsData to pseudoVtxListByRingAndEdge's array corresponding to the incomming ring and edge
    pseudoVtxListByRingAndEdge[selfIsectsData[i][1]][selfIsectsData[i][2]].push(new PseudoVtx(selfIsectsData[i][0], selfIsectsData[i][5], [selfIsectsData[i][1], selfIsectsData[i][2]], [selfIsectsData[i][6], selfIsectsData[i][7]], undefined));
    // selfIsectsData contains double mentions of each intersection, but we only want to add them once to isectList
    if (selfIsectsData[i][11]) isectList.push(new Isect(selfIsectsData[i][0], [selfIsectsData[i][1], selfIsectsData[i][2]], [selfIsectsData[i][6], selfIsectsData[i][7]], undefined, undefined, true, true));
  }
  var numIsect = isectList.length;
  // Sort edge arrays of pseudoVtxListByRingAndEdge by the fractional distance 'param'
  for (var i = 0; i < pseudoVtxListByRingAndEdge.length; i++) {
    for (var j = 0; j < pseudoVtxListByRingAndEdge[i].length; j++) {
      pseudoVtxListByRingAndEdge[i][j].sort(function(a, b){ return (a.param < b.param) ? -1 : 1 ; } );
    }
  }

  // Now we will to loop twice over pseudoVtxListByRingAndEdge and isectList in order to teach each intersection in isectList which is the next intersection along both it's [ring, edge]'s.
  // First, we find the next intersection for each pseudo-vertex in pseudoVtxListByRingAndEdge
  // For each pseudovertex in pseudoVtxListByRingAndEdge (3 loops) look at the next pseudovertex on that edge and find the corresponding intersection by comparing coordinates
  for (var i = 0; i < pseudoVtxListByRingAndEdge.length; i++){
    for (var j = 0; j < pseudoVtxListByRingAndEdge[i].length; j++){
      for (var k = 0; k < pseudoVtxListByRingAndEdge[i][j].length; k++){
        var foundNextIsect = false;
        for (var l = 0; (l < numIsect) && !foundNextIsect; l++) {
          if (k == pseudoVtxListByRingAndEdge[i][j].length-1) { // If it's the last pseudoVertex on that edge, then the next pseudoVertex is the first one on the next edge of that ring.
            if (isectList[l].coord.equals(pseudoVtxListByRingAndEdge[i][(j+1).mod(feature.geometry.coordinates[i].length-1)][0].coord)) {
              pseudoVtxListByRingAndEdge[i][j][k].nxtIsectAlongEdgeIn = l; // For ring-pseudo-vertices, this is wrongly called nxtIsectAlongEdgeIn, as it is actually the next one along ringAndEdgeOut. This is dealt with correctly in the next block.
              foundNextIsect = true;
            }
          } else {
            if (isectList[l].coord.equals(pseudoVtxListByRingAndEdge[i][j][k+1].coord)) {
              pseudoVtxListByRingAndEdge[i][j][k].nxtIsectAlongEdgeIn = l;
              foundNextIsect = true;
            }
          }
        }
      }
    }
  }

  // Second, we port this knowledge of the next intersection over to the intersections in isectList, by finding the (one or two) pseudo-vertices corresponding to each intersection and copying their next-intersection knowledge
  // For ring-vertex-intersections i of ring j and edge k, the corresponding pseudo-vertex is the last one in the previous (k-1) edge's list. We also correct the misnaming that happened in the previous block, since ringAndEdgeOut = ringAndEdge2 for ring vertices.
  var i = 0;
  for (var j = 0; j < pseudoVtxListByRingAndEdge.length; j++) {
    for (var k = 0; k < pseudoVtxListByRingAndEdge[j].length; k++) {
      isectList[i].nxtIsectAlongRingAndEdge2 = pseudoVtxListByRingAndEdge[j][(k-1).mod(pseudoVtxListByRingAndEdge[j].length)][pseudoVtxListByRingAndEdge[j][(k-1).mod(pseudoVtxListByRingAndEdge[j].length)].length-1].nxtIsectAlongEdgeIn;
      i++
    }
  }
  // For self-intersections, we find the corresponding pseudo-vertex by looping through pseudoVtxListByRingAndEdge (3 loops) and comparing coordinates. The next-intersection property we copy depends on how the edges are labeled in the pseudo-vertex
  for (var i = numvertices; i < numIsect; i++) {
    var foundEgde1In = foundEgde2In = false;
    for (var j = 0; (j < pseudoVtxListByRingAndEdge.length) && !(foundEgde1In && foundEgde2In); j++) {
      for (var k = 0; (k < pseudoVtxListByRingAndEdge[j].length) && !(foundEgde1In && foundEgde2In); k++) {
        for (var l = 0; (l < pseudoVtxListByRingAndEdge[j][k].length) && !(foundEgde1In && foundEgde2In); l++) {
          if (isectList[i].coord.equals(pseudoVtxListByRingAndEdge[j][k][l].coord)) { // This will happen twice
            if (isectList[i].ringAndEdge1.equals(pseudoVtxListByRingAndEdge[j][k][l].ringAndEdgeIn)) {
              isectList[i].nxtIsectAlongRingAndEdge1 = pseudoVtxListByRingAndEdge[j][k][l].nxtIsectAlongEdgeIn;
               foundEgde1In = true;
            } else {
              isectList[i].nxtIsectAlongRingAndEdge2 = pseudoVtxListByRingAndEdge[j][k][l].nxtIsectAlongEdgeIn;
              foundEgde2In = true;
            }
          }
        }
      }
    }
  }
  // This explains why, eventhough when we will walk away from an intersection, we will walk way from the corresponding pseudo-vertex along edgeOut, pseudo-vertices have the property 'nxtIsectAlongEdgeIn' in stead of some propery 'nxtPseudoVtxAlongEdgeOut'. This is because this property (which is easy to find out) is used in the above for nxtIsectAlongRingAndEdge1 and nxtIsectAlongRingAndEdge2!


  // Before we start walking over the intersections to build the output rings, we prepare a queue that stores information on intersections we still have to deal with, and put at least one intersection in it.
  // This queue will contain information on intersections where we can start walking from once the current walk is finished, and its parent output ring (the smallest output ring it lies within, -1 if no parent or parent unknown yet) and its winding number (which we can already determine).
  var queue = []
  // For each output ring, add the ring-vertex-intersection with the smalles x-value (i.e. the left-most) as a start intersection. By choosing such an extremal intersections, we are sure to start at an intersection that is a convex vertex of its output ring. By adding them all to the queue, we are sure that no rings will be forgotten. If due to ring-intersections such an intersection will be encountered while walking, it will be removed from the queue.
  var i = 0;
  for (var j = 0; j < numRings; j++) {
    var leftIsect = i;
    for (var k = 0; k < feature.geometry.coordinates[j].length-1; k++) {
      if (isectList[i].coord[0] < isectList[leftIsect].coord[0]) {
        leftIsect = i;
      }
      i++;
    }
    // Compute winding at this left-most ring-vertex-intersection. We thus this by using our knowledge that this extremal vertex must be a convex vertex.
    // We first find the intersection before and after it, and then use them to determine the winding number of the corresponding output ring, since we know that an extremal vertex of a simple, non-self-intersecting ring is always convex, so the only reason it would not be is because the winding number we use to compute it is wrong
    var isectAfterLeftIsect = isectList[leftIsect].nxtIsectAlongRingAndEdge2;
    for (var k = 0; k < isectList.length; k++) {
      if ((isectList[k].nxtIsectAlongRingAndEdge1 == leftIsect) || (isectList[k].nxtIsectAlongRingAndEdge2 == leftIsect)) {
        var isectBeforeLeftIsect = k;
        break
      }
    }
    var windingAtIsect = isConvex([isectList[isectBeforeLeftIsect].coord,isectList[leftIsect].coord,isectList[isectAfterLeftIsect].coord],true) ? 1 : -1;

    queue.push({isect: leftIsect, parent: -1, winding: windingAtIsect})
  }
  // Srt the queue  by the same criterion used to find the leftIsect: the left-most leftIsect must be last in the queue, such that it will be popped first, such that we will work from out to in regarding input rings. This assumtion is used when predicting the winding number and parent of a new queue member.
  queue.sort(function(a, b){ return (isectList[a.isect].coord > isectList[b.isect].coord) ? -1 : 1 });
  if (debug) console.log("Initial state of the queue: "+JSON.stringify(queue));

  // Initialise output
  var outputFeatureArray = [];

  // While the queue is not empty, take the last object (i.e. its intersection) out and start making an output ring by walking in the direction that has not been walked away over yet.
  while (queue.length>0) {
    // Get the last object out of the queue
    var popped = queue.pop();
    var startIsect = popped.isect;
    var currentOutputRingParent = popped.parent;
    var currentOutputRingWinding = popped.winding;
    // Make new output ring and add vertex from starting intersection
    var currentOutputRing = outputFeatureArray.length;
    var currentOutputRingCoords = [isectList[startIsect].coord];
    if (debug) console.log("# Starting output ring number "+outputFeatureArray.length+" with winding "+currentOutputRingWinding+" from intersection "+startIsect);
    if (debug) if (startIsect < numvertices) console.log("This is a ring-vertex-intersections, which means this output ring does not touch existing output rings");
    // Set up the variables used while walking over intersections: 'currentIsect', 'nxtIsect' and 'walkingRingAndEdge'
    var currentIsect = startIsect;
    if (isectList[startIsect].ringAndEdge1Walkable) {
      var walkingRingAndEdge = isectList[startIsect].ringAndEdge1;
      var nxtIsect = isectList[startIsect].nxtIsectAlongRingAndEdge1;
    } else {
      var walkingRingAndEdge = isectList[startIsect].ringAndEdge2;
      var nxtIsect = isectList[startIsect].nxtIsectAlongRingAndEdge2;
    }
    // While we have not arrived back at the same intersection, keep walking
    while (!isectList[startIsect].coord.equals(isectList[nxtIsect].coord)){
      if (debug) console.log("Walking from intersection "+currentIsect+" to "+nxtIsect+" over ring "+walkingRingAndEdge[0]+" and edge "+walkingRingAndEdge[1]);
      currentOutputRingCoords.push(isectList[nxtIsect].coord);
      if (debug) console.log("Adding intersection "+nxtIsect+" to current output ring");
      // If the next intersection is queued, we can remove it, because we will go there now.
      var nxtIsectInQueue = undefined;
      for(var i = 0; i < queue.length; i++) { if (queue[i].isect == nxtIsect) {nxtIsectInQueue = i; break; } }
      if (nxtIsectInQueue != undefined) {
        if (debug) console.log("Removing intersection "+nxtIsect+" from queue");
        queue.splice(nxtIsectInQueue,1);
      }
      // Arriving at this new intersection, we know which will be our next walking ring and edge (if we came from 1 we will walk away from 2 and vice versa),
      // So we can set it as our new walking ring and intersection and remember that we (will) have walked over it
      // If we have never walked away from this new intersection along the other ring and edge then we will soon do, add the intersection (and the parent wand winding number) to the queue
      // (We can predict the winding number and parent as follows: if the edge is convex, the other output ring started from there will have the alternate winding and lie outside of the current one, and thus have the same parent ring as the current ring. Otherwise, it will have the same winding number and lie inside of the current ring. We are, however, only sure of this of an output ring started from there does not enclose the current ring. This is why the initial queue's intersections must be sorted such that outer ones come out first.)
      // We then update the other two walking variables.
      if (walkingRingAndEdge.equals(isectList[nxtIsect].ringAndEdge1)) {
        walkingRingAndEdge = isectList[nxtIsect].ringAndEdge2;
        isectList[nxtIsect].ringAndEdge2Walkable = false;
        if (isectList[nxtIsect].ringAndEdge1Walkable) {
          if (debug) console.log("Adding intersection "+nxtIsect+" to queue");
          var pushing = {isect: nxtIsect};
          if (isConvex([isectList[currentIsect].coord, isectList[nxtIsect].coord, isectList[isectList[nxtIsect].nxtIsectAlongRingAndEdge2].coord],currentOutputRingWinding == 1)) {
            pushing.parent = currentOutputRingParent;
            pushing.winding = -currentOutputRingWinding;
          } else {
            pushing.parent = currentOutputRing;
            pushing.winding = currentOutputRingWinding;
          }
          queue.push(pushing);
        }
        currentIsect = nxtIsect;
        nxtIsect = isectList[nxtIsect].nxtIsectAlongRingAndEdge2;
      } else {
        walkingRingAndEdge = isectList[nxtIsect].ringAndEdge1;
        isectList[nxtIsect].ringAndEdge1Walkable = false;
        if (isectList[nxtIsect].ringAndEdge2Walkable) {
          if (debug) console.log("Adding intersection "+nxtIsect+" to queue");
          var pushing = {isect: nxtIsect};
          if (isConvex([isectList[currentIsect].coord, isectList[nxtIsect].coord, isectList[isectList[nxtIsect].nxtIsectAlongRingAndEdge1].coord],currentOutputRingWinding == 1)) {
            pushing.parent = currentOutputRingParent;
            pushing.winding = -currentOutputRingWinding;
          } else {
            pushing.parent = currentOutputRing;
            pushing.winding = currentOutputRingWinding;
          }
          queue.push(pushing);
        }
        currentIsect = nxtIsect;
        nxtIsect = isectList[nxtIsect].nxtIsectAlongRingAndEdge1;
      }
      if (debug) console.log("Current state of the queue: "+JSON.stringify(queue));
    }
    if (debug) console.log("Walking from intersection "+currentIsect+" to "+nxtIsect+" over ring "+walkingRingAndEdge[0]+" and edge "+walkingRingAndEdge[1]+" and closing ring");
    // Close output ring
    currentOutputRingCoords.push(isectList[nxtIsect].coord);
    // Push output ring to output
    outputFeatureArray.push(helpers.polygon([currentOutputRingCoords],{index: currentOutputRing, parent: currentOutputRingParent, winding: currentOutputRingWinding, netWinding: undefined}));
  }

  var output = helpers.featureCollection(outputFeatureArray);

  determineParents();
  setNetWinding();

  // These functions are also used if no intersections are found
  function determineParents() {
    var featuresWithoutParent = [];
    for (var i = 0; i < output.features.length; i++) {
      if (debug) console.log("Output ring "+i+" has parent "+output.features[i].properties.parent);
      if (output.features[i].properties.parent == -1) featuresWithoutParent.push(i);
    }
    if (debug) console.log("The following output ring(s) have no parent: "+featuresWithoutParent);
    if (featuresWithoutParent.length > 1) {
      for (var i = 0; i < featuresWithoutParent.length; i++) {
        var parent = -1;
        var parentArea = Infinity;
        for (var j = 0; j < output.features.length; j++) {
          if (featuresWithoutParent[i] == j) continue
          if (within(helpers.featureCollection([helpers.point(output.features[featuresWithoutParent[i]].geometry.coordinates[0][0])]),helpers.featureCollection([output.features[j]])).features.length == 1) {
            if (area(output.features[j]) < parentArea) {
              parent = j;
              if (debug) console.log("Ring "+featuresWithoutParent[i]+" lies within output ring "+j);
            }
          }
        }
        output.features[featuresWithoutParent[i]].properties.parent = parent;
        if (debug) console.log("Ring "+featuresWithoutParent[i]+" is assigned parent "+parent);
      }
    }
  }

  function setNetWinding() {
    for (var i = 0; i < output.features.length; i++) {
      if (output.features[i].properties.parent == -1) {
        var netWinding = output.features[i].properties.winding
        output.features[i].properties.netWinding = netWinding;
        setNetWindingOfChildren(i,netWinding)
      }
    }
  }

  function setNetWindingOfChildren(parent,ParentNetWinding){
    for (var i = 0; i < output.features.length; i++) {
      if (output.features[i].properties.parent == parent){
        var netWinding = ParentNetWinding + output.features[i].properties.winding
        output.features[i].properties.netWinding = netWinding;
        setNetWindingOfChildren(i,netWinding)
      }
    }
  }

  if (debug) console.log("# Total of "+output.features.length+" rings");

  return output;
}



// Constructor for (ring- or intersection-) pseudo-vertices.
var PseudoVtx = function (coord, param, ringAndEdgeIn, ringAndEdgeOut, nxtIsectAlongEdgeIn) {
  this.coord = coord; // [x,y] of this pseudo-vertex
  this.param = param; // fractional distance of this intersection on incomming edge
  this.ringAndEdgeIn = ringAndEdgeIn; // [ring index, edge index] of incomming edge
  this.ringAndEdgeOut = ringAndEdgeOut; // [ring index, edge index] of outgoing edge
  this.nxtIsectAlongEdgeIn = nxtIsectAlongEdgeIn; // The next intersection when following the incomming edge (so not when following ringAndEdgeOut!)
}

// Constructor for a intersection. There are two intersection-pseudo-vertices per self-intersection and one ring-pseudo-vertex per ring-vertex-intersection. Their labels 1 and 2 are not assigned a particular meaning but are permanent once given.
var Isect = function (coord, ringAndEdge1, ringAndEdge2, nxtIsectAlongRingAndEdge1, nxtIsectAlongRingAndEdge2, ringAndEdge1Walkable, ringAndEdge2Walkable) {
  this.coord = coord; // [x,y] of this intersection
  this.ringAndEdge1 = ringAndEdge1; // first edge of this intersection
  this.ringAndEdge2 = ringAndEdge2; // second edge of this intersection
  this.nxtIsectAlongRingAndEdge1 = nxtIsectAlongRingAndEdge1; // the next intersection when following ringAndEdge1
  this.nxtIsectAlongRingAndEdge2 = nxtIsectAlongRingAndEdge2; // the next intersection when following ringAndEdge2
  this.ringAndEdge1Walkable = ringAndEdge1Walkable; // May we (still) walk away from this intersection over ringAndEdge1?
  this.ringAndEdge2Walkable = ringAndEdge2Walkable; // May we (still) walk away from this intersection over ringAndEdge2?
}

// Function to determine if three consecutive points of a simple, non-self-intersecting ring make up a convex vertex, assuming the ring is right- or lefthanded
function isConvex(pts, righthanded){
  // 'pts' is an [x,y] pair
  // 'righthanded' is a boolean
  if (typeof(righthanded) === 'undefined') righthanded = true;
  if (pts.length != 3) throw new Error("This function requires an array of three points [x,y]");
  var d = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0]);
  return (d >= 0) == righthanded;
}

// Function to compute winding of simple, non-self-intersecting ring
function windingOfRing(ring){
  // 'ring' is an array of [x,y] pairs with the last equal to the first
  // Compute the winding number based on the vertex with the smallest x-value, it precessor and successor. An extremal vertex of a simple, non-self-intersecting ring is always convex, so the only reason it is not is because the winding number we use to compute it is wrong
  var leftVtx = 0;
  for (var i = 0; i < ring.length-1; i++) { if (ring[i][0] < ring[leftVtx][0]) leftVtx = i; }
  if (isConvex([ring[(leftVtx-1).mod(ring.length-1)],ring[leftVtx],ring[(leftVtx+1).mod(ring.length-1)]],true)) {
    var winding = 1;
  } else {
    var winding = -1;
  }
  return winding
}

// Function to compare Arrays of numbers. From http://stackoverflow.com/questions/7837456/how-to-compare-arrays-in-javascript
// Warn if overriding existing method
// if(Array.prototype.equals) console.warn("Overriding existing Array.prototype.equals. Possible causes: New API defines the method, there's a framework conflict or you've got double inclusions in your code.");
// attach the .equals method to Array's prototype to call it on any array
Array.prototype.equals = function (array) {
    // if the other array is a falsy value, return
    if (!array)
        return false;

    // compare lengths - can save a lot of time
    if (this.length != array.length)
        return false;

    for (var i = 0, l=this.length; i < l; i++) {
        // Check if we have nested arrays
        if (this[i] instanceof Array && array[i] instanceof Array) {
            // recurse into the nested arrays
            if (!this[i].equals(array[i]))
                return false;
        }
        else if (this[i] != array[i]) {
            // Warning - two different object instances will never be equal: {x:20} != {x:20}
            return false;
        }
    }
    return true;
}
// Hide method from for-in loops
Object.defineProperty(Array.prototype, "equals", {enumerable: false});

// Fix Javascript modulo for negative number. From http://stackoverflow.com/questions/4467539/javascript-modulo-not-behaving
Number.prototype.mod = function(n) {
    return ((this%n)+n)%n;
}

// Function to get array with only unique elements. From http://stackoverflow.com/questions/1960473/unique-values-in-an-array
Array.prototype.getUnique = function(){
   var u = {}, a = [];
   for(var i = 0, l = this.length; i < l; ++i){
      if(u.hasOwnProperty(this[i])) {
         continue;
      }
      a.push(this[i]);
      u[this[i]] = 1;
   }
   return a;
}

// Function to check if array is unique (i.e. all unique elements, i.e. no duplicate elements)
Array.prototype.isUnique = function(){
   var u = {}, a = [];
   var isUnique = 1;
   for(var i = 0, l = this.length; i < l; ++i){
      if(u.hasOwnProperty(this[i])) {
        isUnique = 0;
        break;
      }
      u[this[i]] = 1;
   }
   return isUnique;
}
