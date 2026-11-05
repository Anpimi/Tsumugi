// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.
// Standalone generator: ajv 8.20.0 (MIT).
// The MIT License (MIT)
//
// Copyright (c) 2015-2021 Evgeny Poberezkin
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
"use strict";
export const validate = validate321;
export default validate321;
const schema338 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"SourceCaptureSummary","type":"object","properties":{"materials":{"type":"array","items":{"$ref":"#/$defs/SourceCaptureMaterial"}}},"additionalProperties":false,"required":["materials"],"$defs":{"SourceCaptureCounts":{"type":"object","properties":{"declaredFields":{"type":"integer","maximum":4294967295,"minimum":0},"items":{"type":"integer","maximum":4294967295,"minimum":0},"itemsWithFields":{"type":"integer","maximum":4294967295,"minimum":0},"nonEmptyFields":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["items","itemsWithFields","declaredFields","nonEmptyFields"]},"SourceCaptureGroup":{"type":"object","properties":{"counts":{"$ref":"#/$defs/SourceCaptureCounts"},"label":{"type":"string"}},"additionalProperties":false,"required":["label","counts"]},"SourceCaptureMaterial":{"type":"object","properties":{"counts":{"$ref":"#/$defs/SourceCaptureCounts"},"groups":{"description":"When supplied, the disjoint groups must sum to the material counts.","type":"array","items":{"$ref":"#/$defs/SourceCaptureGroup"}},"properties":{"type":"array","items":{"$ref":"#/$defs/SourceCaptureProperty"}},"source":{"description":"Captured parse-input evidence, not a filesystem path or read permission.","$ref":"#/$defs/SourceReference"}},"additionalProperties":false,"required":["source","properties","counts","groups"]},"SourceCaptureProperty":{"description":"Labels and values are literal plugin-authored data, rendered as plain text.\nAn empty values list explicitly reports no values, rather than missing data.","type":"object","properties":{"label":{"type":"string"},"values":{"type":"array","items":{"type":"string"}}},"additionalProperties":false,"required":["label","values"]},"SourceEncoding":{"description":"Source coordinates are separate from ranges in decoded unit/target text.","type":"string","enum":["utf8-byte","utf16","grapheme","raw-byte"]},"SourceRange":{"type":"object","properties":{"encoding":{"$ref":"#/$defs/SourceEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]},"SourceReference":{"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/SourceRange"}},"additionalProperties":false,"required":["artifactId","range"]}}};
const schema339 = {"type":"object","properties":{"counts":{"$ref":"#/$defs/SourceCaptureCounts"},"groups":{"description":"When supplied, the disjoint groups must sum to the material counts.","type":"array","items":{"$ref":"#/$defs/SourceCaptureGroup"}},"properties":{"type":"array","items":{"$ref":"#/$defs/SourceCaptureProperty"}},"source":{"description":"Captured parse-input evidence, not a filesystem path or read permission.","$ref":"#/$defs/SourceReference"}},"additionalProperties":false,"required":["source","properties","counts","groups"]};
const schema340 = {"type":"object","properties":{"declaredFields":{"type":"integer","maximum":4294967295,"minimum":0},"items":{"type":"integer","maximum":4294967295,"minimum":0},"itemsWithFields":{"type":"integer","maximum":4294967295,"minimum":0},"nonEmptyFields":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["items","itemsWithFields","declaredFields","nonEmptyFields"]};
const schema343 = {"description":"Labels and values are literal plugin-authored data, rendered as plain text.\nAn empty values list explicitly reports no values, rather than missing data.","type":"object","properties":{"label":{"type":"string"},"values":{"type":"array","items":{"type":"string"}}},"additionalProperties":false,"required":["label","values"]};
const schema341 = {"type":"object","properties":{"counts":{"$ref":"#/$defs/SourceCaptureCounts"},"label":{"type":"string"}},"additionalProperties":false,"required":["label","counts"]};

function validate323(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate323.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.label === undefined) && (missing0 = "label")) || ((data.counts === undefined) && (missing0 = "counts"))){
validate323.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "counts") || (key0 === "label"))){
validate323.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.counts !== undefined){
let data0 = data.counts;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if(((((data0.items === undefined) && (missing1 = "items")) || ((data0.itemsWithFields === undefined) && (missing1 = "itemsWithFields"))) || ((data0.declaredFields === undefined) && (missing1 = "declaredFields"))) || ((data0.nonEmptyFields === undefined) && (missing1 = "nonEmptyFields"))){
validate323.errors = [{instancePath:instancePath+"/counts",schemaPath:"#/$defs/SourceCaptureCounts/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!((((key1 === "declaredFields") || (key1 === "items")) || (key1 === "itemsWithFields")) || (key1 === "nonEmptyFields"))){
validate323.errors = [{instancePath:instancePath+"/counts",schemaPath:"#/$defs/SourceCaptureCounts/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.declaredFields !== undefined){
let data1 = data0.declaredFields;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate323.errors = [{instancePath:instancePath+"/counts/declaredFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/declaredFields/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate323.errors = [{instancePath:instancePath+"/counts/declaredFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/declaredFields/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate323.errors = [{instancePath:instancePath+"/counts/declaredFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/declaredFields/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid2 = _errs6 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.items !== undefined){
let data2 = data0.items;
const _errs8 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate323.errors = [{instancePath:instancePath+"/counts/items",schemaPath:"#/$defs/SourceCaptureCounts/properties/items/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs8){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate323.errors = [{instancePath:instancePath+"/counts/items",schemaPath:"#/$defs/SourceCaptureCounts/properties/items/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate323.errors = [{instancePath:instancePath+"/counts/items",schemaPath:"#/$defs/SourceCaptureCounts/properties/items/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.itemsWithFields !== undefined){
let data3 = data0.itemsWithFields;
const _errs10 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate323.errors = [{instancePath:instancePath+"/counts/itemsWithFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/itemsWithFields/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate323.errors = [{instancePath:instancePath+"/counts/itemsWithFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/itemsWithFields/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 0 || isNaN(data3)){
validate323.errors = [{instancePath:instancePath+"/counts/itemsWithFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/itemsWithFields/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.nonEmptyFields !== undefined){
let data4 = data0.nonEmptyFields;
const _errs12 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
validate323.errors = [{instancePath:instancePath+"/counts/nonEmptyFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/nonEmptyFields/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs12){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate323.errors = [{instancePath:instancePath+"/counts/nonEmptyFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/nonEmptyFields/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 0 || isNaN(data4)){
validate323.errors = [{instancePath:instancePath+"/counts/nonEmptyFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/nonEmptyFields/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid2 = _errs12 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
}
else {
validate323.errors = [{instancePath:instancePath+"/counts",schemaPath:"#/$defs/SourceCaptureCounts/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.label !== undefined){
const _errs14 = errors;
if(typeof data.label !== "string"){
validate323.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs14 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate323.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate323.errors = vErrors;
return errors === 0;
}
validate323.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema344 = {"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/SourceRange"}},"additionalProperties":false,"required":["artifactId","range"]};
const schema345 = {"type":"object","properties":{"encoding":{"$ref":"#/$defs/SourceEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]};
const schema346 = {"description":"Source coordinates are separate from ranges in decoded unit/target text.","type":"string","enum":["utf8-byte","utf16","grapheme","raw-byte"]};

function validate326(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate326.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.encoding === undefined) && (missing0 = "encoding")) || ((data.start === undefined) && (missing0 = "start"))) || ((data.end === undefined) && (missing0 = "end"))){
validate326.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "encoding") || (key0 === "end")) || (key0 === "start"))){
validate326.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.encoding !== undefined){
let data0 = data.encoding;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate326.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/SourceEncoding/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!((((data0 === "utf8-byte") || (data0 === "utf16")) || (data0 === "grapheme")) || (data0 === "raw-byte"))){
validate326.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/SourceEncoding/enum",keyword:"enum",params:{allowedValues: schema346.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.end !== undefined){
let data1 = data.end;
const _errs5 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate326.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate326.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate326.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.start !== undefined){
let data2 = data.start;
const _errs7 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate326.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate326.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate326.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
else {
validate326.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate326.errors = vErrors;
return errors === 0;
}
validate326.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate325(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate325.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.artifactId === undefined) && (missing0 = "artifactId")) || ((data.range === undefined) && (missing0 = "range"))){
validate325.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "artifactId") || (key0 === "range"))){
validate325.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.artifactId !== undefined){
const _errs2 = errors;
if(typeof data.artifactId !== "string"){
validate325.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"#/properties/artifactId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.range !== undefined){
const _errs4 = errors;
if(!(validate326(data.range, {instancePath:instancePath+"/range",parentData:data,parentDataProperty:"range",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate326.errors : vErrors.concat(validate326.errors);
errors = vErrors.length;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate325.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate325.errors = vErrors;
return errors === 0;
}
validate325.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate322(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate322.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.source === undefined) && (missing0 = "source")) || ((data.properties === undefined) && (missing0 = "properties"))) || ((data.counts === undefined) && (missing0 = "counts"))) || ((data.groups === undefined) && (missing0 = "groups"))){
validate322.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "counts") || (key0 === "groups")) || (key0 === "properties")) || (key0 === "source"))){
validate322.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.counts !== undefined){
let data0 = data.counts;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if(((((data0.items === undefined) && (missing1 = "items")) || ((data0.itemsWithFields === undefined) && (missing1 = "itemsWithFields"))) || ((data0.declaredFields === undefined) && (missing1 = "declaredFields"))) || ((data0.nonEmptyFields === undefined) && (missing1 = "nonEmptyFields"))){
validate322.errors = [{instancePath:instancePath+"/counts",schemaPath:"#/$defs/SourceCaptureCounts/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!((((key1 === "declaredFields") || (key1 === "items")) || (key1 === "itemsWithFields")) || (key1 === "nonEmptyFields"))){
validate322.errors = [{instancePath:instancePath+"/counts",schemaPath:"#/$defs/SourceCaptureCounts/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.declaredFields !== undefined){
let data1 = data0.declaredFields;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate322.errors = [{instancePath:instancePath+"/counts/declaredFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/declaredFields/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate322.errors = [{instancePath:instancePath+"/counts/declaredFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/declaredFields/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate322.errors = [{instancePath:instancePath+"/counts/declaredFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/declaredFields/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid2 = _errs6 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.items !== undefined){
let data2 = data0.items;
const _errs8 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate322.errors = [{instancePath:instancePath+"/counts/items",schemaPath:"#/$defs/SourceCaptureCounts/properties/items/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs8){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate322.errors = [{instancePath:instancePath+"/counts/items",schemaPath:"#/$defs/SourceCaptureCounts/properties/items/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate322.errors = [{instancePath:instancePath+"/counts/items",schemaPath:"#/$defs/SourceCaptureCounts/properties/items/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.itemsWithFields !== undefined){
let data3 = data0.itemsWithFields;
const _errs10 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate322.errors = [{instancePath:instancePath+"/counts/itemsWithFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/itemsWithFields/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate322.errors = [{instancePath:instancePath+"/counts/itemsWithFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/itemsWithFields/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 0 || isNaN(data3)){
validate322.errors = [{instancePath:instancePath+"/counts/itemsWithFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/itemsWithFields/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.nonEmptyFields !== undefined){
let data4 = data0.nonEmptyFields;
const _errs12 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
validate322.errors = [{instancePath:instancePath+"/counts/nonEmptyFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/nonEmptyFields/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs12){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate322.errors = [{instancePath:instancePath+"/counts/nonEmptyFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/nonEmptyFields/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 0 || isNaN(data4)){
validate322.errors = [{instancePath:instancePath+"/counts/nonEmptyFields",schemaPath:"#/$defs/SourceCaptureCounts/properties/nonEmptyFields/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid2 = _errs12 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
}
else {
validate322.errors = [{instancePath:instancePath+"/counts",schemaPath:"#/$defs/SourceCaptureCounts/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.groups !== undefined){
let data5 = data.groups;
const _errs14 = errors;
if(errors === _errs14){
if(Array.isArray(data5)){
var valid3 = true;
const len0 = data5.length;
for(let i0=0; i0<len0; i0++){
const _errs16 = errors;
if(!(validate323(data5[i0], {instancePath:instancePath+"/groups/" + i0,parentData:data5,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate323.errors : vErrors.concat(validate323.errors);
errors = vErrors.length;
}
var valid3 = _errs16 === errors;
if(!valid3){
break;
}
}
}
else {
validate322.errors = [{instancePath:instancePath+"/groups",schemaPath:"#/properties/groups/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs14 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.properties !== undefined){
let data7 = data.properties;
const _errs17 = errors;
if(errors === _errs17){
if(Array.isArray(data7)){
var valid4 = true;
const len1 = data7.length;
for(let i1=0; i1<len1; i1++){
let data8 = data7[i1];
const _errs19 = errors;
const _errs20 = errors;
if(errors === _errs20){
if(data8 && typeof data8 == "object" && !Array.isArray(data8)){
let missing2;
if(((data8.label === undefined) && (missing2 = "label")) || ((data8.values === undefined) && (missing2 = "values"))){
validate322.errors = [{instancePath:instancePath+"/properties/" + i1,schemaPath:"#/$defs/SourceCaptureProperty/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs22 = errors;
for(const key2 in data8){
if(!((key2 === "label") || (key2 === "values"))){
validate322.errors = [{instancePath:instancePath+"/properties/" + i1,schemaPath:"#/$defs/SourceCaptureProperty/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs22 === errors){
if(data8.label !== undefined){
const _errs23 = errors;
if(typeof data8.label !== "string"){
validate322.errors = [{instancePath:instancePath+"/properties/" + i1+"/label",schemaPath:"#/$defs/SourceCaptureProperty/properties/label/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid6 = _errs23 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data8.values !== undefined){
let data10 = data8.values;
const _errs25 = errors;
if(errors === _errs25){
if(Array.isArray(data10)){
var valid7 = true;
const len2 = data10.length;
for(let i2=0; i2<len2; i2++){
const _errs27 = errors;
if(typeof data10[i2] !== "string"){
validate322.errors = [{instancePath:instancePath+"/properties/" + i1+"/values/" + i2,schemaPath:"#/$defs/SourceCaptureProperty/properties/values/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid7 = _errs27 === errors;
if(!valid7){
break;
}
}
}
else {
validate322.errors = [{instancePath:instancePath+"/properties/" + i1+"/values",schemaPath:"#/$defs/SourceCaptureProperty/properties/values/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid6 = _errs25 === errors;
}
else {
var valid6 = true;
}
}
}
}
}
else {
validate322.errors = [{instancePath:instancePath+"/properties/" + i1,schemaPath:"#/$defs/SourceCaptureProperty/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid4 = _errs19 === errors;
if(!valid4){
break;
}
}
}
else {
validate322.errors = [{instancePath:instancePath+"/properties",schemaPath:"#/properties/properties/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs17 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.source !== undefined){
const _errs29 = errors;
if(!(validate325(data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate325.errors : vErrors.concat(validate325.errors);
errors = vErrors.length;
}
var valid0 = _errs29 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
else {
validate322.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate322.errors = vErrors;
return errors === 0;
}
validate322.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate321(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate321.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((data.materials === undefined) && (missing0 = "materials")){
validate321.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(key0 === "materials")){
validate321.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.materials !== undefined){
let data0 = data.materials;
const _errs2 = errors;
if(errors === _errs2){
if(Array.isArray(data0)){
var valid1 = true;
const len0 = data0.length;
for(let i0=0; i0<len0; i0++){
const _errs4 = errors;
if(!(validate322(data0[i0], {instancePath:instancePath+"/materials/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate322.errors : vErrors.concat(validate322.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate321.errors = [{instancePath:instancePath+"/materials",schemaPath:"#/properties/materials/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
}
}
}
}
else {
validate321.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate321.errors = vErrors;
return errors === 0;
}
validate321.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
