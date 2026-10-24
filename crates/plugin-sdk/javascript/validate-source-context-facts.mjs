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
export const validate = validate281;
export default validate281;
const schema303 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"SourceContextFacts","description":"The surrounding DomainBlock supplies Snapshot/Unit/Occurrence applicability.\nEmpty facts report an explicit empty observation; absence is not that report.","type":"object","properties":{"facts":{"type":"array","items":{"$ref":"#/$defs/SourceContextFact"},"maxItems":32}},"additionalProperties":false,"required":["facts"],"$defs":{"SourceContextFact":{"type":"object","properties":{"id":{"description":"Unique only inside this block; it is not a project revision or entity ID.","type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}(?![\\s\\S])"},"kind":{"$ref":"#/$defs/SourceContextFactKind"},"origin":{"$ref":"#/$defs/SourceContextFactOrigin"},"text":{"type":"string","pattern":"^[\\s\\S]{1,4096}(?![\\s\\S])"}},"additionalProperties":false,"required":["id","kind","text","origin"]},"SourceContextFactKind":{"description":"Classification for presentation, without interpreting a format's syntax or\nnormalizing its literal text. Other source-associated information uses Note.","type":"string","enum":["speaker","role","scene","time","location","note"]},"SourceContextFactOrigin":{"description":"References are observations in captured source, not proof of an inference.\nHuman project decisions remain in the project's independent revision owner.","oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"extracted"},"sources":{"type":"array","items":{"$ref":"#/$defs/SourceReference"},"maxItems":8,"minItems":1}},"additionalProperties":false,"required":["kind","sources"]},{"type":"object","properties":{"kind":{"type":"string","const":"inferred"},"rationale":{"type":"string","pattern":"^[\\s\\S]{1,4096}(?![\\s\\S])"},"sources":{"type":"array","items":{"$ref":"#/$defs/SourceReference"},"maxItems":8,"minItems":1}},"additionalProperties":false,"required":["kind","rationale","sources"]}]},"SourceReference":{"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["artifactId","range"]},"TextEncoding":{"type":"string","enum":["utf8-byte","utf16","grapheme"]},"TextRange":{"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]}}};
const schema304 = {"type":"object","properties":{"id":{"description":"Unique only inside this block; it is not a project revision or entity ID.","type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}(?![\\s\\S])"},"kind":{"$ref":"#/$defs/SourceContextFactKind"},"origin":{"$ref":"#/$defs/SourceContextFactOrigin"},"text":{"type":"string","pattern":"^[\\s\\S]{1,4096}(?![\\s\\S])"}},"additionalProperties":false,"required":["id","kind","text","origin"]};
const schema305 = {"description":"Classification for presentation, without interpreting a format's syntax or\nnormalizing its literal text. Other source-associated information uses Note.","type":"string","enum":["speaker","role","scene","time","location","note"]};
const pattern10 = new RegExp("^[A-Za-z0-9.\\-_:/]{1,128}(?![\\s\\S])", "u");
const pattern11 = new RegExp("^[\\s\\S]{1,4096}(?![\\s\\S])", "u");
const schema306 = {"description":"References are observations in captured source, not proof of an inference.\nHuman project decisions remain in the project's independent revision owner.","oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"extracted"},"sources":{"type":"array","items":{"$ref":"#/$defs/SourceReference"},"maxItems":8,"minItems":1}},"additionalProperties":false,"required":["kind","sources"]},{"type":"object","properties":{"kind":{"type":"string","const":"inferred"},"rationale":{"type":"string","pattern":"^[\\s\\S]{1,4096}(?![\\s\\S])"},"sources":{"type":"array","items":{"$ref":"#/$defs/SourceReference"},"maxItems":8,"minItems":1}},"additionalProperties":false,"required":["kind","rationale","sources"]}]};
const schema307 = {"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["artifactId","range"]};
const schema308 = {"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]};
const schema309 = {"type":"string","enum":["utf8-byte","utf16","grapheme"]};

function validate285(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate285.evaluated;
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
validate285.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "encoding") || (key0 === "end")) || (key0 === "start"))){
validate285.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.encoding !== undefined){
let data0 = data.encoding;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate285.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((data0 === "utf8-byte") || (data0 === "utf16")) || (data0 === "grapheme"))){
validate285.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/enum",keyword:"enum",params:{allowedValues: schema309.enum},message:"must be equal to one of the allowed values"}];
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
validate285.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate285.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate285.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate285.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate285.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate285.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate285.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate285.errors = vErrors;
return errors === 0;
}
validate285.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate284(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate284.evaluated;
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
validate284.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "artifactId") || (key0 === "range"))){
validate284.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.artifactId !== undefined){
const _errs2 = errors;
if(typeof data.artifactId !== "string"){
validate284.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"#/properties/artifactId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
if(!(validate285(data.range, {instancePath:instancePath+"/range",parentData:data,parentDataProperty:"range",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate285.errors : vErrors.concat(validate285.errors);
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
validate284.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate284.errors = vErrors;
return errors === 0;
}
validate284.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate283(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate283.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
const _errs0 = errors;
let valid0 = false;
let passing0 = null;
const _errs1 = errors;
if(errors === _errs1){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.kind === undefined) && (missing0 = "kind")) || ((data.sources === undefined) && (missing0 = "sources"))){
const err0 = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs3 = errors;
for(const key0 in data){
if(!((key0 === "kind") || (key0 === "sources"))){
const err1 = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
break;
}
}
if(_errs3 === errors){
if(data.kind !== undefined){
let data0 = data.kind;
const _errs4 = errors;
if(typeof data0 !== "string"){
const err2 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if("extracted" !== data0){
const err3 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "extracted"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var valid1 = _errs4 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.sources !== undefined){
let data1 = data.sources;
const _errs6 = errors;
if(errors === _errs6){
if(Array.isArray(data1)){
if(data1.length > 8){
const err4 = {instancePath:instancePath+"/sources",schemaPath:"#/oneOf/0/properties/sources/maxItems",keyword:"maxItems",params:{limit: 8},message:"must NOT have more than 8 items"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
else {
if(data1.length < 1){
const err5 = {instancePath:instancePath+"/sources",schemaPath:"#/oneOf/0/properties/sources/minItems",keyword:"minItems",params:{limit: 1},message:"must NOT have fewer than 1 items"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
else {
var valid2 = true;
const len0 = data1.length;
for(let i0=0; i0<len0; i0++){
const _errs8 = errors;
if(!(validate284(data1[i0], {instancePath:instancePath+"/sources/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate284.errors : vErrors.concat(validate284.errors);
errors = vErrors.length;
}
var valid2 = _errs8 === errors;
if(!valid2){
break;
}
}
}
}
}
else {
const err6 = {instancePath:instancePath+"/sources",schemaPath:"#/oneOf/0/properties/sources/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
}
var valid1 = _errs6 === errors;
}
else {
var valid1 = true;
}
}
}
}
}
else {
const err7 = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
}
var _valid0 = _errs1 === errors;
if(_valid0){
valid0 = true;
passing0 = 0;
var props0 = true;
}
const _errs9 = errors;
if(errors === _errs9){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing1;
if((((data.kind === undefined) && (missing1 = "kind")) || ((data.rationale === undefined) && (missing1 = "rationale"))) || ((data.sources === undefined) && (missing1 = "sources"))){
const err8 = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
else {
const _errs11 = errors;
for(const key1 in data){
if(!(((key1 === "kind") || (key1 === "rationale")) || (key1 === "sources"))){
const err9 = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
break;
}
}
if(_errs11 === errors){
if(data.kind !== undefined){
let data3 = data.kind;
const _errs12 = errors;
if(typeof data3 !== "string"){
const err10 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
if("inferred" !== data3){
const err11 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "inferred"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
var valid3 = _errs12 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data.rationale !== undefined){
let data4 = data.rationale;
const _errs14 = errors;
if(errors === _errs14){
if(typeof data4 === "string"){
if(!pattern11.test(data4)){
const err12 = {instancePath:instancePath+"/rationale",schemaPath:"#/oneOf/1/properties/rationale/pattern",keyword:"pattern",params:{pattern: "^[\\s\\S]{1,4096}(?![\\s\\S])"},message:"must match pattern \""+"^[\\s\\S]{1,4096}(?![\\s\\S])"+"\""};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
else {
const err13 = {instancePath:instancePath+"/rationale",schemaPath:"#/oneOf/1/properties/rationale/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
}
var valid3 = _errs14 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data.sources !== undefined){
let data5 = data.sources;
const _errs16 = errors;
if(errors === _errs16){
if(Array.isArray(data5)){
if(data5.length > 8){
const err14 = {instancePath:instancePath+"/sources",schemaPath:"#/oneOf/1/properties/sources/maxItems",keyword:"maxItems",params:{limit: 8},message:"must NOT have more than 8 items"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
else {
if(data5.length < 1){
const err15 = {instancePath:instancePath+"/sources",schemaPath:"#/oneOf/1/properties/sources/minItems",keyword:"minItems",params:{limit: 1},message:"must NOT have fewer than 1 items"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
else {
var valid4 = true;
const len1 = data5.length;
for(let i1=0; i1<len1; i1++){
const _errs18 = errors;
if(!(validate284(data5[i1], {instancePath:instancePath+"/sources/" + i1,parentData:data5,parentDataProperty:i1,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate284.errors : vErrors.concat(validate284.errors);
errors = vErrors.length;
}
var valid4 = _errs18 === errors;
if(!valid4){
break;
}
}
}
}
}
else {
const err16 = {instancePath:instancePath+"/sources",schemaPath:"#/oneOf/1/properties/sources/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
}
var valid3 = _errs16 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
}
else {
const err17 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
}
var _valid0 = _errs9 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 1];
}
else {
if(_valid0){
valid0 = true;
passing0 = 1;
if(props0 !== true){
props0 = true;
}
}
}
if(!valid0){
const err18 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
validate283.errors = vErrors;
return false;
}
else {
errors = _errs0;
if(vErrors !== null){
if(_errs0){
vErrors.length = _errs0;
}
else {
vErrors = null;
}
}
}
validate283.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate283.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate282(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate282.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.id === undefined) && (missing0 = "id")) || ((data.kind === undefined) && (missing0 = "kind"))) || ((data.text === undefined) && (missing0 = "text"))) || ((data.origin === undefined) && (missing0 = "origin"))){
validate282.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "id") || (key0 === "kind")) || (key0 === "origin")) || (key0 === "text"))){
validate282.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.id !== undefined){
let data0 = data.id;
const _errs2 = errors;
if(errors === _errs2){
if(typeof data0 === "string"){
if(!pattern10.test(data0)){
validate282.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}(?![\\s\\S])"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}(?![\\s\\S])"+"\""}];
return false;
}
}
else {
validate282.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.kind !== undefined){
let data1 = data.kind;
const _errs4 = errors;
if(typeof data1 !== "string"){
validate282.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/SourceContextFactKind/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!((((((data1 === "speaker") || (data1 === "role")) || (data1 === "scene")) || (data1 === "time")) || (data1 === "location")) || (data1 === "note"))){
validate282.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/SourceContextFactKind/enum",keyword:"enum",params:{allowedValues: schema305.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.origin !== undefined){
const _errs7 = errors;
if(!(validate283(data.origin, {instancePath:instancePath+"/origin",parentData:data,parentDataProperty:"origin",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate283.errors : vErrors.concat(validate283.errors);
errors = vErrors.length;
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.text !== undefined){
let data3 = data.text;
const _errs8 = errors;
if(errors === _errs8){
if(typeof data3 === "string"){
if(!pattern11.test(data3)){
validate282.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/pattern",keyword:"pattern",params:{pattern: "^[\\s\\S]{1,4096}(?![\\s\\S])"},message:"must match pattern \""+"^[\\s\\S]{1,4096}(?![\\s\\S])"+"\""}];
return false;
}
}
else {
validate282.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs8 === errors;
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
validate282.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate282.errors = vErrors;
return errors === 0;
}
validate282.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate281(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate281.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((data.facts === undefined) && (missing0 = "facts")){
validate281.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(key0 === "facts")){
validate281.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.facts !== undefined){
let data0 = data.facts;
const _errs2 = errors;
if(errors === _errs2){
if(Array.isArray(data0)){
if(data0.length > 32){
validate281.errors = [{instancePath:instancePath+"/facts",schemaPath:"#/properties/facts/maxItems",keyword:"maxItems",params:{limit: 32},message:"must NOT have more than 32 items"}];
return false;
}
else {
var valid1 = true;
const len0 = data0.length;
for(let i0=0; i0<len0; i0++){
const _errs4 = errors;
if(!(validate282(data0[i0], {instancePath:instancePath+"/facts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate282.errors : vErrors.concat(validate282.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
}
else {
validate281.errors = [{instancePath:instancePath+"/facts",schemaPath:"#/properties/facts/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
}
}
}
}
else {
validate281.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate281.errors = vErrors;
return errors === 0;
}
validate281.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
